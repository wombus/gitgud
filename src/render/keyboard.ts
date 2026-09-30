import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { keycapAtlas } from './textures';

/**
 * A full keyboard built key by key, so each keycap can physically depress when
 * the player types. Keys are addressed by KeyboardEvent.code.
 */

type KeyDef = [code: string, label: string, width?: number];

const U = 0.0188; // one key unit in meters
const GAP = 0.0016;

const ROWS: KeyDef[][] = [
  [['Escape', 'esc'], ['F1', 'F1'], ['F2', 'F2'], ['F3', 'F3'], ['F4', 'F4'], ['F5', 'F5'], ['F6', 'F6'], ['F7', 'F7'], ['F8', 'F8'], ['F9', 'F9'], ['F10', 'F10'], ['F11', 'F11'], ['F12', 'F12']],
  [
    ['Backquote', '`'], ['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'], ['Digit5', '5'], ['Digit6', '6'], ['Digit7', '7'],
    ['Digit8', '8'], ['Digit9', '9'], ['Digit0', '0'], ['Minus', '-'], ['Equal', '='], ['Backspace', 'del', 2],
  ],
  [
    ['Tab', 'tab', 1.5], ['KeyQ', 'Q'], ['KeyW', 'W'], ['KeyE', 'E'], ['KeyR', 'R'], ['KeyT', 'T'], ['KeyY', 'Y'], ['KeyU', 'U'], ['KeyI', 'I'],
    ['KeyO', 'O'], ['KeyP', 'P'], ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\', 1.5],
  ],
  [
    ['CapsLock', 'caps', 1.75], ['KeyA', 'A'], ['KeyS', 'S'], ['KeyD', 'D'], ['KeyF', 'F'], ['KeyG', 'G'], ['KeyH', 'H'], ['KeyJ', 'J'],
    ['KeyK', 'K'], ['KeyL', 'L'], ['Semicolon', ';'], ['Quote', "'"], ['Enter', 'enter', 2.25],
  ],
  [
    ['ShiftLeft', 'shift', 2.25], ['KeyZ', 'Z'], ['KeyX', 'X'], ['KeyC', 'C'], ['KeyV', 'V'], ['KeyB', 'B'], ['KeyN', 'N'], ['KeyM', 'M'],
    ['Comma', ','], ['Period', '.'], ['Slash', '/'], ['ShiftRight', 'shift', 2.75],
  ],
  [
    ['ControlLeft', 'ctrl', 1.25], ['MetaLeft', '◆', 1.25], ['AltLeft', 'alt', 1.25], ['Space', '', 6.25], ['AltRight', 'alt', 1.25],
    ['MetaRight', '◆', 1.25], ['ContextMenu', '≡', 1.25], ['ControlRight', 'ctrl', 1.25],
  ],
];

const ARROWS: Array<[string, string, number, number]> = [
  ['ArrowUp', '↑', 1, 4],
  ['ArrowLeft', '←', 0, 5],
  ['ArrowDown', '↓', 1, 5],
  ['ArrowRight', '→', 2, 5],
];

interface KeyState {
  obj: THREE.Object3D;
  baseY: number;
  pressedAt: number;
}

export class Keyboard {
  group = new THREE.Group();
  private keys = new Map<string, KeyState>();

  constructor() {
    const labels: string[] = [];
    const all: Array<{ code: string; label: string; x: number; row: number; w: number }> = [];
    ROWS.forEach((row, r) => {
      let x = 0;
      for (const [code, label, w = 1] of row) {
        all.push({ code, label, x, row: r, w });
        x += w + (r === 0 && (code === 'Escape' || code === 'F4' || code === 'F8') ? 0.5 : 0);
      }
    });
    const mainWidth = 15;
    for (const [code, label, col, row] of ARROWS) all.push({ code, label, x: mainWidth + 0.35 + col, row, w: 1 });
    for (const k of all) labels.push(k.label);
    const atlas = keycapAtlas(labels);

    const capMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.62, metalness: 0.0 });
    const legendMat = new THREE.MeshStandardMaterial({ map: atlas.texture, roughness: 0.6, metalness: 0 });
    const totalW = (mainWidth + 3.6) * U;
    const totalD = 6.2 * U;
    const offsetX = -totalW / 2;
    const offsetZ = -totalD / 2 + U * 0.6;

    const capGeoms = new Map<number, THREE.BufferGeometry>();
    const capGeom = (w: number) => {
      const key = Math.round(w * 100);
      let g = capGeoms.get(key);
      if (!g) {
        g = new RoundedBoxGeometry(w * U - GAP, 0.0075, U - GAP, 2, 0.0018);
        capGeoms.set(key, g);
      }
      return g;
    };

    all.forEach((k, i) => {
      const obj = new THREE.Group();
      const cap = new THREE.Mesh(capGeom(k.w), capMat);
      cap.castShadow = true;
      cap.receiveShadow = true;
      obj.add(cap);
      if (k.label) {
        const pw = Math.min(k.w, 1.6) * U * 0.72;
        const ph = U * 0.72;
        const plane = new THREE.PlaneGeometry(pw, ph);
        const col = i % atlas.cols;
        const row = Math.floor(i / atlas.cols);
        const u0 = col / atlas.cols;
        const u1 = (col + 1) / atlas.cols;
        const v1 = 1 - row / atlas.rows;
        const v0 = 1 - (row + 1) / atlas.rows;
        const uv = plane.attributes.uv as THREE.BufferAttribute;
        uv.setXY(0, u0, v1);
        uv.setXY(1, u1, v1);
        uv.setXY(2, u0, v0);
        uv.setXY(3, u1, v0);
        const legend = new THREE.Mesh(plane, legendMat);
        legend.rotation.x = -Math.PI / 2;
        legend.position.y = 0.0038;
        obj.add(legend);
      }
      const x = offsetX + (k.x + k.w / 2) * U;
      const rowZ = k.row === 0 ? -0.35 : 0;
      const z = offsetZ + (k.row + rowZ) * U;
      // Keyboard rows step up slightly toward the back (sculpted profile).
      const y = 0.0105 + (5 - k.row) * 0.0006;
      obj.position.set(x, y, z);
      this.group.add(obj);
      this.keys.set(k.code, { obj, baseY: y, pressedAt: -1 });
    });

    // Case
    const caseMat = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.45, metalness: 0.15 });
    const shell = new THREE.Mesh(new RoundedBoxGeometry(totalW + 0.014, 0.012, totalD + 0.012, 3, 0.004), caseMat);
    shell.position.set(0, 0.006, -U * 0.6 + offsetZ + totalD / 2);
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.group.add(shell);
    // A tiny caps-lock-ish status LED, because details.
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.0012, 8, 8), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x4cc3ff, emissiveIntensity: 3 }));
    led.position.set(totalW / 2 - 0.01, 0.0125, offsetZ - U * 0.9);
    this.group.add(led);
  }

  press(code: string, now: number): void {
    const k = this.keys.get(code);
    if (k) k.pressedAt = now;
  }

  update(now: number): void {
    for (const k of this.keys.values()) {
      if (k.pressedAt < 0) continue;
      const t = (now - k.pressedAt) / 1000;
      // Quick press, springy release.
      const depth = t < 0.035 ? t / 0.035 : Math.max(0, 1 - (t - 0.035) / 0.09);
      k.obj.position.y = k.baseY - depth * 0.0032;
      if (t > 0.2) {
        k.obj.position.y = k.baseY;
        k.pressedAt = -1;
      }
    }
  }
}
