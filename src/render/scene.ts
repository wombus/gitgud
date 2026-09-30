import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { animateSteam, buildOffice, SCREEN_H, SCREEN_W, updateMonitorFrames, type OfficeObjects } from './office';
import { certificate, nameplate, skyForHour, skylineTexture } from './textures';

export type Quality = 'low' | 'medium' | 'high';
export type Focus = 'terminal' | 'chat' | 'overview';

/** Film grain + vignette + a hint of chromatic aberration, applied after tone mapping. */
const FilmShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    grain: { value: 0.028 },
    vignette: { value: 0.22 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float grain;
    uniform float vignette;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      float d = dot(c, c);
      vec2 off = c * d * 0.0035;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      float n = hash(vUv * vec2(1920.0, 1080.0) + fract(time) * 100.0) - 0.5;
      col += n * grain;
      col *= 1.0 - vignette * smoothstep(0.12, 0.62, d * 1.6);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

interface Pose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
}

export class OfficeRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  office: OfficeObjects;
  terminalTexture: THREE.CanvasTexture;
  chatTexture: THREE.CanvasTexture;
  focus: Focus = 'overview';
  quality: Quality = 'high';
  reduceMotion = false;

  private composer!: EffectComposer;
  private gtao: GTAOPass | null = null;
  private bloom!: UnrealBloomPass;
  private film!: ShaderPass;
  private keyLight!: THREE.SpotLight;
  private windowLight!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private lamp!: THREE.PointLight;
  private ceilingLights: THREE.RectAreaLight[] = [];
  private termGlow!: THREE.RectAreaLight;
  private chatGlow!: THREE.RectAreaLight;
  private poses: Record<Focus, Pose>;
  private camPos = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private gaze = new THREE.Vector2();
  private gazeTarget = new THREE.Vector2();
  private clock = new THREE.Clock();
  private raycaster = new THREE.Raycaster();

  constructor(
    private container: HTMLElement,
    terminalCanvas: HTMLCanvasElement,
    chatCanvas: HTMLCanvasElement,
    playerName: string,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.02, 60);

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const screenTex = (c: HTMLCanvasElement) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = maxAniso;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      return t;
    };
    this.terminalTexture = screenTex(terminalCanvas);
    this.chatTexture = screenTex(chatCanvas);

    // Image-based lighting: a neutral "room" environment for soft reflections.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.28;
    this.scene.background = new THREE.Color(0x0b0d12);
    this.scene.fog = new THREE.Fog(0x9aa3ad, 6, 16);

    this.office = buildOffice(this.terminalTexture, this.chatTexture, playerName);
    this.scene.add(this.office.root);
    updateMonitorFrames(this.office.terminal);
    updateMonitorFrames(this.office.chat);

    this.addLights();
    this.poses = this.computePoses();
    this.camPos.copy(this.poses.overview.pos);
    this.camTarget.copy(this.poses.overview.target);
    this.setupComposer();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private addLights(): void {
    RectAreaLightUniformsLib.init();
    // Troffer directly above the desk plus neighbours.
    for (const [x, z, i] of [
      [0, -0.3, 5],
      [0, -2.7, 6],
      [2.4, -0.3, 3.5],
      [-2.4, -0.3, 3.5],
    ] as Array<[number, number, number]>) {
      const l = new THREE.RectAreaLight(0xfff4e6, i, 1.18, 0.58);
      l.position.set(x, 2.79, z);
      l.lookAt(x, 0, z);
      this.scene.add(l);
      this.ceilingLights.push(l);
    }
    // Shadow-casting key light standing in for the overhead fixture.
    this.keyLight = new THREE.SpotLight(0xfff1dd, 11, 7, Math.PI / 4.2, 0.85, 2);
    this.keyLight.position.set(0.35, 2.7, 0.55);
    this.keyLight.target.position.set(0, 0.74, -0.2);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.015;
    this.keyLight.shadow.radius = 6;
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 5;
    this.scene.add(this.keyLight, this.keyLight.target);

    // Monitor glow: light spilling from each screen onto the desk and keyboard.
    const glow = (rig: OfficeObjects['terminal'], color: number, intensity: number) => {
      const l = new THREE.RectAreaLight(color, intensity, SCREEN_W, SCREEN_H);
      l.position.copy(rig.center).addScaledVector(rig.normal, 0.01);
      l.lookAt(rig.center.clone().addScaledVector(rig.normal, 1));
      this.scene.add(l);
      return l;
    };
    this.termGlow = glow(this.office.terminal, 0x8fa6c8, 3.2);
    this.chatGlow = glow(this.office.chat, 0xe8ecf5, 2.6);

    this.windowLight = new THREE.DirectionalLight(0xdfe9ff, 0.6);
    this.windowLight.position.set(0.8, 2.6, -7);
    this.windowLight.target.position.set(0, 0.8, 0);
    this.scene.add(this.windowLight, this.windowLight.target);

    this.hemi = new THREE.HemisphereLight(0xf2f0ea, 0x3a3f4a, 0.35);
    this.scene.add(this.hemi);

    this.lamp = new THREE.PointLight(0xffc987, 0, 1.6, 2);
    this.lamp.position.copy(this.office.lampBulb.userData.world as THREE.Vector3).add(new THREE.Vector3(0, -0.04, 0.03));
    this.scene.add(this.lamp);
  }

  private setupComposer(): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.camera, size.x, size.y);
    this.gtao.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: 16 });
    this.gtao.blendIntensity = 0.85;
    this.composer.addPass(this.gtao);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.16, 0.4, 0.97);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.film = new ShaderPass(FilmShader);
    this.composer.addPass(this.film);
    this.applyQuality();
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.applyQuality();
  }

  private applyQuality(): void {
    const q = this.quality;
    this.renderer.setPixelRatio(q === 'low' ? 1 : Math.min(window.devicePixelRatio, q === 'high' ? 2 : 1.5));
    this.renderer.shadowMap.enabled = q !== 'low';
    this.keyLight.castShadow = q !== 'low';
    if (this.gtao) this.gtao.enabled = q === 'high';
    this.bloom.enabled = q !== 'low';
    this.resize();
  }

  /** Where the camera sits to look at each monitor (fit to the viewport). */
  private computePoses(): Record<Focus, Pose> {
    const fit = (rig: OfficeObjects['terminal'], fill: number): Pose => {
      const vfov = THREE.MathUtils.degToRad(this.camera.fov);
      const aspect = this.camera.aspect || 16 / 9;
      const dH = (SCREEN_H / fill / 2) / Math.tan(vfov / 2);
      const dW = (SCREEN_W / Math.min(0.96, fill * 1.15) / 2) / (Math.tan(vfov / 2) * aspect);
      const d = Math.max(dH, dW);
      const pos = rig.center.clone().addScaledVector(rig.normal, d);
      pos.y += 0.035;
      return { pos, target: rig.center.clone().add(new THREE.Vector3(0, -0.012, 0)) };
    };
    return {
      terminal: fit(this.office.terminal, 0.84),
      chat: fit(this.office.chat, 0.84),
      overview: { pos: new THREE.Vector3(0.05, 1.22, 0.78), target: new THREE.Vector3(-0.12, 0.98, -0.3) },
    };
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.composer?.setSize(w, h);
    this.composer?.setPixelRatio(pr);
    this.gtao?.setSize(w * pr, h * pr);
    this.poses = this.computePoses();
  }

  setFocus(f: Focus): void {
    this.focus = f;
  }

  /** Which monitor (if any) is under a point in client coordinates. */
  pickScreen(clientX: number, clientY: number): 'terminal' | 'chat' | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const { terminal, chat } = this.office;
    const hit = this.raycaster.intersectObjects([terminal.group, chat.group], true)[0];
    if (!hit) return null;
    for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
      if (o === terminal.group) return 'terminal';
      if (o === chat.group) return 'chat';
    }
    return null;
  }

  /** Jump straight to the current pose (used while the screen is black). */
  snapCamera(): void {
    const pose = this.poses[this.focus];
    this.camPos.copy(pose.pos);
    this.camTarget.copy(pose.target);
    this.gaze.set(0, 0);
    this.gazeTarget.set(0, 0);
  }

  /** Mouse position in [-1, 1] for the subtle head-follows-gaze effect. */
  setGaze(x: number, y: number): void {
    this.gazeTarget.set(x, y);
  }

  setHour(h: number): void {
    const old = this.office.windowMaterial.map;
    this.office.windowMaterial.map = skylineTexture(h);
    this.office.windowMaterial.needsUpdate = true;
    old?.dispose();
    const pal = skyForHour(h);
    const day = 1 - pal.night;
    this.windowLight.color.set(pal.sun ?? (day > 0.5 ? '#dfe9ff' : '#6f84b8'));
    this.windowLight.intensity = 0.15 + 0.75 * day;
    this.scene.fog!.color.set(day > 0.5 ? 0x9aa3ad : 0x2a3142);
    this.hemi.intensity = 0.2 + 0.2 * day;
    // After hours: half the office lights are off and the desk lamp comes on.
    const late = h >= 19 || h < 7;
    this.ceilingLights.forEach((l, i) => (l.intensity = late && i > 0 ? 0.6 : [5, 6, 3.5, 3.5][i]));
    this.office.ceilingPanels.forEach((p, i) => ((p.material as THREE.MeshStandardMaterial).emissiveIntensity = late && i > 0 ? 0.25 : 2.2));
    this.lamp.intensity = late ? 1.2 : h >= 17 ? 0.5 : 0;
    (this.office.lampBulb.material as THREE.MeshStandardMaterial).emissiveIntensity = this.lamp.intensity > 0 ? 4 : 0;
  }

  setPlayerName(name: string): void {
    const m = this.office.nameplateMaterial;
    m.map?.dispose();
    m.map = nameplate(name);
    m.needsUpdate = true;
    const cm = this.office.certificateMaterial;
    cm.map?.dispose();
    cm.map = certificate(name);
    cm.needsUpdate = true;
  }

  pressKey(code: string): void {
    this.office.keyboard.press(code, performance.now());
  }

  markScreensDirty(terminal: boolean, chat: boolean): void {
    if (terminal) this.terminalTexture.needsUpdate = true;
    if (chat) this.chatTexture.needsUpdate = true;
  }

  frame(): void {
    const dt = Math.min(0.2, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    const pose = this.poses[this.focus];
    const k = 1 - Math.exp(-dt * (this.reduceMotion ? 20 : 4.5));
    this.camPos.lerp(pose.pos, k);
    this.camTarget.lerp(pose.target, k);
    this.gaze.lerp(this.gazeTarget, 1 - Math.exp(-dt * 3));

    const breathe = this.reduceMotion ? 0 : 1;
    const bob = new THREE.Vector3(Math.sin(t * 0.37) * 0.0022, Math.sin(t * 0.9) * 0.0016, Math.sin(t * 0.23) * 0.002).multiplyScalar(breathe);
    const lookRange = this.focus === 'overview' ? 0.25 : 0.045;
    const target = this.camTarget.clone().add(new THREE.Vector3(this.gaze.x * lookRange, -this.gaze.y * lookRange * 0.6, 0));
    this.camera.position.copy(this.camPos).add(bob);
    this.camera.lookAt(target);

    // Keep the screens' light spill in sync with what's on them (roughly).
    this.termGlow.intensity = 3.2;
    this.chatGlow.intensity = 2.6;

    this.office.keyboard.update(performance.now());
    if (!this.reduceMotion) animateSteam(this.office.coffeeSteam, dt, t);
    this.film.uniforms.time.value = t;
    this.composer.render(dt);
  }

  /** True if WebGL initialized (for fallbacks). */
  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }
}
