import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Keyboard } from './keyboard';
import {
  calendarTexture,
  carpet,
  catPhoto,
  ceilingTile,
  certificate,
  cheatSheetPoster,
  deskLaminate,
  fabric,
  mugLabel,
  nameplate,
  plasticRoughness,
  skylineTexture,
  stickyNote,
} from './textures';

/**
 * The cubicle. Units are meters; +y is up, the player sits looking toward -z.
 *
 * Realism mostly comes from small things: bevelled edges that catch light,
 * physically based materials, clutter at believable scales, and light that
 * spills from the monitors onto the desk.
 */

export const DESK_Y = 0.74;
export const SCREEN_W = 0.62;
export const SCREEN_H = 0.349;

export interface MonitorRig {
  group: THREE.Group;
  screen: THREE.Mesh;
  /** World-space center of the screen surface. */
  center: THREE.Vector3;
  /** World-space direction the screen faces. */
  normal: THREE.Vector3;
}

export interface OfficeObjects {
  root: THREE.Group;
  terminal: MonitorRig;
  chat: MonitorRig;
  keyboard: Keyboard;
  windowMaterial: THREE.MeshBasicMaterial;
  nameplateMaterial: THREE.MeshStandardMaterial;
  certificateMaterial: THREE.MeshStandardMaterial;
  ceilingPanels: THREE.Mesh[];
  lampBulb: THREE.Mesh;
  coffeeSteam: THREE.Points;
}

function rbox(w: number, h: number, d: number, r: number, mat: THREE.Material, segments = 3): THREE.Mesh {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, segments, r), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function plane(w: number, h: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.receiveShadow = true;
  return m;
}

function buildMonitor(screenTexture: THREE.Texture, plastic: THREE.Material, brightness: number): MonitorRig {
  const group = new THREE.Group();
  const bezel = 0.012;
  const chin = 0.022;
  const bodyW = SCREEN_W + bezel * 2;
  const bodyH = SCREEN_H + bezel + chin;
  const body = rbox(bodyW, bodyH, 0.024, 0.006, plastic, 4);
  body.position.set(0, -(chin - bezel) / 2, -0.012);
  group.add(body);

  const back = rbox(bodyW * 0.72, bodyH * 0.7, 0.045, 0.02, plastic, 4);
  back.position.set(0, -0.02, -0.04);
  group.add(back);

  // Matte anti-glare panel: the image is emissive; reflections are faint and broad.
  const screenMat = new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: 0xffffff,
    emissiveMap: screenTexture,
    emissiveIntensity: brightness,
    roughness: 0.82,
    metalness: 0.0,
    envMapIntensity: 0.12,
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), screenMat);
  screen.position.z = 0.0005;
  group.add(screen);

  // Power LED on the chin
  const led = new THREE.Mesh(new THREE.CircleGeometry(0.0016, 12), new THREE.MeshBasicMaterial({ color: 0xbfe6ff }));
  led.position.set(bodyW / 2 - 0.03, -SCREEN_H / 2 - chin / 2 - 0.001, 0.0005);
  group.add(led);

  // Stand: neck + foot
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.35, metalness: 0.85 });
  const neck = rbox(0.055, 0.3, 0.018, 0.006, metal);
  neck.position.set(0, -SCREEN_H / 2 - 0.08, -0.075);
  neck.rotation.x = -0.12;
  group.add(neck);
  const foot = rbox(0.25, 0.012, 0.19, 0.006, metal);
  foot.position.set(0, -SCREEN_H / 2 - 0.26, -0.06);
  group.add(foot);

  return { group, screen, center: new THREE.Vector3(), normal: new THREE.Vector3() };
}

export function buildOffice(terminalTexture: THREE.Texture, chatTexture: THREE.Texture, playerName: string): OfficeObjects {
  const root = new THREE.Group();

  /* ------------------------------ materials ----------------------------- */
  const lam = deskLaminate();
  const deskMat = new THREE.MeshStandardMaterial({ ...lam, roughness: 1, metalness: 0 });
  deskMat.normalScale.set(0.25, 0.25);
  const deskEdgeMat = new THREE.MeshStandardMaterial({ color: 0x3b3833, roughness: 0.5 });
  const fab = fabric('#687384');
  const panelMat = new THREE.MeshStandardMaterial({ ...fab, roughness: 0.96 });
  panelMat.normalScale.set(0.6, 0.6);
  const fabOther = fabric('#6f7a6d', 8);
  const panelMatOther = new THREE.MeshStandardMaterial({ ...fabOther, roughness: 0.96 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.7 });
  const plasticRough = plasticRoughness();
  const plastic = new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.55, roughnessMap: plasticRough, metalness: 0.05 });
  const carp = carpet();
  const floorMat = new THREE.MeshStandardMaterial({ ...carp, roughness: 1 });
  const ceil = ceilingTile();
  const ceilingMat = new THREE.MeshStandardMaterial({ ...ceil, roughness: 0.95 });
  ceil.map.wrapS = ceil.map.wrapT = THREE.RepeatWrapping;
  ceil.map.repeat.set(20, 20);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.9 });

  /* -------------------------------- room -------------------------------- */
  const floor = plane(24, 24, floorMat);
  floor.rotation.x = -Math.PI / 2;
  root.add(floor);

  const ceiling = plane(24, 24, ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 2.8;
  root.add(ceiling);

  // Fluorescent troffers
  const ceilingPanels: THREE.Mesh[] = [];
  const panelLight = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff8ee, emissiveIntensity: 2.2 });
  for (const [x, z] of [
    [0, -0.3],
    [0, -2.7],
    [-2.4, -0.3],
    [2.4, -0.3],
    [-2.4, -2.7],
    [2.4, -2.7],
    [0, -5.1],
    [-2.4, -5.1],
    [2.4, -5.1],
    [0, 2.1],
  ]) {
    const p = plane(1.18, 0.58, panelLight);
    p.rotation.x = Math.PI / 2;
    p.position.set(x, 2.795, z);
    root.add(p);
    ceilingPanels.push(p);
  }

  // Far window wall with a city view
  const windowMaterial = new THREE.MeshBasicMaterial({ map: skylineTexture(10), toneMapped: false });
  const view = plane(14, 3.2, windowMaterial);
  view.position.set(0, 1.6, -7.2);
  root.add(view);
  const mullionMat = new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.5, metalness: 0.6 });
  for (let i = -6; i <= 6; i += 1.5) {
    const m = rbox(0.06, 2.4, 0.08, 0.01, mullionMat);
    m.position.set(i, 1.55, -7.05);
    root.add(m);
  }
  const sill = rbox(14, 0.08, 0.3, 0.02, wallMat);
  sill.position.set(0, 0.35, -7.0);
  root.add(sill);
  const header = plane(14, 0.5, wallMat);
  header.position.set(0, 2.55, -7.0);
  root.add(header);

  /* ------------------------------ cubicle ------------------------------- */
  const cubicle = new THREE.Group();
  const wallH = 1.28;
  const addPanel = (w: number, x: number, z: number, rotY: number, mat = panelMat) => {
    const p = rbox(w, wallH, 0.06, 0.012, mat, 2);
    p.position.set(x, wallH / 2, z);
    p.rotation.y = rotY;
    cubicle.add(p);
    const cap = rbox(w + 0.01, 0.025, 0.07, 0.008, trimMat, 2);
    cap.position.set(x, wallH + 0.012, z);
    cap.rotation.y = rotY;
    cubicle.add(cap);
  };
  addPanel(2.1, 0, -0.66, 0);
  addPanel(1.7, -1.05, 0.2, Math.PI / 2);
  addPanel(1.7, 1.05, 0.2, Math.PI / 2);
  root.add(cubicle);

  // Neighbouring cubicle rows (backdrop)
  for (const [x, z, w, rot] of [
    [0, -2.9, 2.1, 0],
    [-2.3, -0.66, 2.1, 0],
    [2.3, -0.66, 2.1, 0],
    [-2.3, -2.9, 2.1, 0],
    [2.3, -2.9, 2.1, 0],
    [0, -4.9, 2.1, 0],
    [-2.3, -4.9, 2.1, 0],
    [2.3, -4.9, 2.1, 0],
    [-1.25, -1.8, 2.2, Math.PI / 2],
    [1.25, -1.8, 2.2, Math.PI / 2],
    [-1.25, -4.0, 2.2, Math.PI / 2],
    [1.25, -4.0, 2.2, Math.PI / 2],
  ] as Array<[number, number, number, number]>) {
    const p = rbox(w, wallH, 0.06, 0.012, (Math.abs(x) + Math.abs(z)) % 2 > 1 ? panelMatOther : panelMat, 2);
    p.position.set(x, wallH / 2, z);
    p.rotation.y = rot;
    root.add(p);
    const cap = rbox(w + 0.01, 0.025, 0.07, 0.008, trimMat, 2);
    cap.position.set(x, wallH + 0.012, z);
    cap.rotation.y = rot;
    root.add(cap);
  }
  // Some monitor backs peeking over far partitions
  for (const [x, z] of [
    [-0.4, -2.55],
    [0.5, -2.55],
    [-2.6, -2.55],
    [2.1, -4.55],
    [-1.9, -4.55],
  ]) {
    const mb = rbox(0.6, 0.36, 0.05, 0.01, plastic);
    mb.position.set(x, 1.1, z);
    mb.rotation.y = Math.PI;
    root.add(mb);
  }
  // A tall office plant in the aisle, because every office has one.
  const potMat = new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.6 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f6b3a, roughness: 0.7, side: THREE.DoubleSide });
  const bigPlant = makePlant(potMat, leafMat, 0.28, 1.2, 38);
  bigPlant.position.set(-2.6, 0, -1.8);
  root.add(bigPlant);

  /* -------------------------------- desk -------------------------------- */
  const desk = new THREE.Group();
  const top = rbox(2.0, 0.03, 0.95, 0.008, deskMat, 3);
  top.position.set(0, DESK_Y - 0.015, -0.18);
  desk.add(top);
  const edge = rbox(2.0, 0.006, 0.01, 0.002, deskEdgeMat);
  edge.position.set(0, DESK_Y - 0.015, 0.295);
  desk.add(edge);
  const pedestal = rbox(0.42, 0.7, 0.6, 0.01, new THREE.MeshStandardMaterial({ color: 0x5b5e66, roughness: 0.55, metalness: 0.4 }));
  pedestal.position.set(0.7, 0.35, -0.3);
  desk.add(pedestal);
  root.add(desk);

  /* ------------------------------ monitors ------------------------------ */
  const terminal = buildMonitor(terminalTexture, plastic, 1.0);
  terminal.group.position.set(0, DESK_Y + 0.265 + SCREEN_H / 2 - 0.03, -0.3);
  terminal.group.rotation.x = -0.03;
  root.add(terminal.group);

  const chat = buildMonitor(chatTexture, plastic, 0.8);
  const angle = 0.62;
  const half = SCREEN_W / 2 + 0.018;
  chat.group.position.set(-half - Math.cos(angle) * half - 0.01, terminal.group.position.y, -0.3 + Math.sin(angle) * half);
  chat.group.rotation.set(-0.03, angle, 0, 'YXZ');
  root.add(chat.group);

  /* ----------------------------- desk clutter ---------------------------- */
  const keyboard = new Keyboard();
  keyboard.group.position.set(0, DESK_Y, 0.02);
  root.add(keyboard.group);

  const padMat = new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: 0.95 });
  const pad = rbox(0.26, 0.003, 0.22, 0.002, padMat);
  pad.position.set(0.38, DESK_Y + 0.0015, 0.04);
  root.add(pad);
  const mouse = new THREE.Mesh(new THREE.SphereGeometry(0.032, 24, 16), plastic);
  mouse.scale.set(0.95, 0.55, 1.7);
  mouse.position.set(0.38, DESK_Y + 0.018, 0.05);
  mouse.castShadow = true;
  root.add(mouse);

  // Coffee mug, with coffee and a wisp of steam
  const ceramic = new THREE.MeshPhysicalMaterial({ map: mugLabel(), roughness: 0.18, clearcoat: 0.8, clearcoatRoughness: 0.1 });
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.041, 0.038, 0.1, 40, 1, true), ceramic);
  mug.position.set(0.62, DESK_Y + 0.05, -0.02);
  mug.rotation.y = -2.2;
  mug.castShadow = true;
  root.add(mug);
  const mugInside = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.035, 0.098, 40, 1, true), new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.2, side: THREE.BackSide }));
  mugInside.position.copy(mug.position);
  root.add(mugInside);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.038, 32), ceramic);
  bottom.rotation.x = -Math.PI / 2;
  bottom.position.set(0.62, DESK_Y + 0.001, -0.02);
  root.add(bottom);
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.037, 32), new THREE.MeshPhysicalMaterial({ color: 0x2a160b, roughness: 0.05, clearcoat: 1 }));
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.set(0.62, DESK_Y + 0.085, -0.02);
  root.add(coffee);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.007, 12, 24, Math.PI * 1.2), ceramic);
  handle.position.set(0.662, DESK_Y + 0.05, -0.02);
  handle.rotation.z = -Math.PI * 0.6;
  handle.castShadow = true;
  root.add(handle);
  const coffeeSteam = makeSteam();
  coffeeSteam.position.set(0.62, DESK_Y + 0.1, -0.02);
  root.add(coffeeSteam);

  // Rubber debugging duck on the monitor foot
  const duck = makeDuck();
  duck.position.set(0.1, DESK_Y + 0.012, -0.24);
  duck.rotation.y = -0.5;
  root.add(duck);

  // Desk plant (pothos in a little pot)
  const smallPlant = makePlant(potMat, new THREE.MeshStandardMaterial({ color: 0x3f8a3f, roughness: 0.6, side: THREE.DoubleSide }), 0.06, 0.18, 22);
  smallPlant.position.set(-0.93, DESK_Y, -0.5);
  root.add(smallPlant);

  // Desk phone
  const phone = rbox(0.2, 0.05, 0.18, 0.012, plastic);
  phone.position.set(-0.7, DESK_Y + 0.025, -0.36);
  phone.rotation.set(-0.15, 0.3, 0);
  root.add(phone);
  const handset = rbox(0.05, 0.03, 0.2, 0.012, plastic);
  handset.position.set(-0.76, DESK_Y + 0.06, -0.34);
  handset.rotation.y = 0.3;
  root.add(handset);

  // Stack of printouts nobody will read
  const paperMat = new THREE.MeshStandardMaterial({ color: 0xf3f1ec, roughness: 0.9 });
  for (let i = 0; i < 6; i++) {
    const sheet = rbox(0.21, 0.004, 0.297, 0.001, paperMat, 1);
    sheet.position.set(-0.62 + (i % 2) * 0.006, DESK_Y + 0.002 + i * 0.004, 0.06 + (i % 3) * 0.004);
    sheet.rotation.y = 0.25 + (i % 2) * 0.05;
    root.add(sheet);
  }

  // Sticky notes on the monitor bezel
  // Stuck to the outside of the bezel so they never cover the terminal.
  const notes: Array<[string[], string, number, number, number]> = [
    [['NEVER', 'push to', 'main!!'], '#fdf08a', SCREEN_W / 2 + 0.042, -0.1, 0.08],
    [['wifi pw:', 'hunter2'], '#ffb3c7', -SCREEN_W / 2 - 0.04, -0.12, -0.1],
    [['git', 'status', 'FIRST'], '#b5f0ff', SCREEN_W / 2 + 0.036, 0.08, -0.05],
  ];
  for (const [lines, color, x, y, rot] of notes) {
    const note = plane(0.06, 0.06, new THREE.MeshStandardMaterial({ map: stickyNote(lines, color, rot * 0.5), roughness: 0.9, side: THREE.DoubleSide }));
    note.position.set(x, y, 0.002);
    note.rotation.z = rot;
    terminal.group.add(note);
  }

  /* ------------------------ things pinned to walls ---------------------- */
  const pinned = (tex: THREE.Texture, w: number, h: number, x: number, y: number, rot = 0, z = -0.628) => {
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
    const m = plane(w, h, mat);
    m.position.set(x, y, z);
    m.rotation.z = rot;
    root.add(m);
    return { mesh: m, mat };
  };
  pinned(cheatSheetPoster(), 0.3, 0.4, 0.74, 1.05, 0.02);
  pinned(calendarTexture(), 0.22, 0.264, -0.76, 1.02, -0.015);
  pinned(catPhoto(), 0.15, 0.12, 0.45, 1.16, -0.05);
  // The certificate hangs on the left side panel, facing inward.
  const cert = pinned(certificate(playerName), 0.21, 0.15, -1.015, 1.08, 0, 0.12);
  cert.mesh.rotation.set(0, Math.PI / 2, 0);
  const certificateMaterial = cert.mat;
  const nameplateMaterial = new THREE.MeshStandardMaterial({ map: nameplate(playerName), roughness: 0.3, metalness: 0.6 });
  const plate = plane(0.24, 0.06, nameplateMaterial);
  plate.position.set(0.99, 1.16, 0.55);
  plate.rotation.y = -Math.PI / 2;
  root.add(plate);

  // Desk lamp (for late nights), in the back-right corner, angled at the keyboard.
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x2b2e35, roughness: 0.4, metalness: 0.6 });
  const lamp = new THREE.Group();
  const lampBase = rbox(0.12, 0.018, 0.12, 0.008, lampMat);
  lampBase.position.set(0, 0.009, 0);
  lamp.add(lampBase);
  const arm1 = rbox(0.014, 0.36, 0.014, 0.005, lampMat);
  arm1.position.set(0, 0.18, -0.03);
  arm1.rotation.x = -0.18;
  lamp.add(arm1);
  const arm2 = rbox(0.014, 0.26, 0.014, 0.005, lampMat);
  arm2.position.set(0, 0.4, 0.06);
  arm2.rotation.x = 1.0;
  lamp.add(arm2);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.08, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0x2b2e35, roughness: 0.4, metalness: 0.5, side: THREE.DoubleSide }));
  shade.position.set(0, 0.44, 0.17);
  shade.rotation.x = 0.55;
  shade.castShadow = true;
  lamp.add(shade);
  const lampBulb = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffd9a0, emissiveIntensity: 0 }));
  lampBulb.position.set(0, 0.415, 0.185);
  lamp.add(lampBulb);
  lamp.position.set(0.93, DESK_Y, -0.5);
  lamp.rotation.y = -0.55;
  root.add(lamp);
  lamp.updateMatrixWorld(true);
  const bulbWorld = lampBulb.getWorldPosition(new THREE.Vector3());
  lampBulb.userData.world = bulbWorld;

  return { root, terminal, chat, keyboard, windowMaterial, nameplateMaterial, certificateMaterial, ceilingPanels, lampBulb, coffeeSteam };
}

/** Update world-space centers/normals of the monitors (after they are placed). */
export function updateMonitorFrames(rig: MonitorRig): void {
  rig.group.updateWorldMatrix(true, true);
  rig.screen.getWorldPosition(rig.center);
  rig.normal.set(0, 0, 1).applyQuaternion(rig.screen.getWorldQuaternion(new THREE.Quaternion())).normalize();
}

function makeDuck(): THREE.Group {
  const g = new THREE.Group();
  const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffcf1f, roughness: 0.35, clearcoat: 0.6 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.03, 24, 16), yellow);
  body.scale.set(1.2, 0.85, 1);
  body.position.y = 0.026;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.019, 24, 16), yellow);
  head.position.set(0.018, 0.058, 0);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.018, 12), new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5 }));
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(0.04, 0.055, 0);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 });
  for (const z of [-0.009, 0.009]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.0028, 8, 8), eyeMat);
    eye.position.set(0.031, 0.064, z);
    g.add(eye);
  }
  for (const m of [body, head, beak]) {
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

function makePlant(potMat: THREE.Material, leafMat: THREE.Material, potR: number, height: number, leaves: number): THREE.Group {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(potR, potR * 0.78, potR * 1.4, 32), potMat);
  pot.position.y = potR * 0.7;
  pot.castShadow = true;
  pot.receiveShadow = true;
  g.add(pot);
  const soil = new THREE.Mesh(new THREE.CircleGeometry(potR * 0.95, 24), new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 1 }));
  soil.rotation.x = -Math.PI / 2;
  soil.position.y = potR * 1.35;
  g.add(soil);
  const leafGeo = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  let seed = 17;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < leaves; i++) {
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    const a = rnd() * Math.PI * 2;
    const r = rnd() * potR * 1.6;
    const h = potR * 1.4 + rnd() * height;
    const s = potR * (0.35 + rnd() * 0.35) * (height > 0.5 ? 0.9 : 1.4);
    leaf.scale.set(s * 0.55, s * 0.08, s);
    leaf.position.set(Math.cos(a) * r, h, Math.sin(a) * r);
    leaf.rotation.set(-0.6 + rnd() * 0.5, a + Math.PI / 2, rnd() * 0.6 - 0.3);
    leaf.castShadow = true;
    g.add(leaf);
  }
  return g;
}

function makeSteam(): THREE.Points {
  const n = 40;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 0.03;
    pos[i * 3 + 1] = Math.random() * 0.12;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 0.03;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.012, transparent: true, opacity: 0.12, depthWrite: false });
  return new THREE.Points(geo, mat);
}

export function animateSteam(p: THREE.Points, dt: number, t: number): void {
  const pos = p.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let y = pos.getY(i) + dt * 0.03;
    let x = pos.getX(i) + Math.sin(t * 1.3 + i) * dt * 0.004;
    if (y > 0.14) {
      y = 0;
      x = (Math.random() - 0.5) * 0.02;
    }
    pos.setXY(i, x, y);
  }
  pos.needsUpdate = true;
}
