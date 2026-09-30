import * as THREE from 'three';
import { HAND, MONO, SANS } from '../ui/screens/theme';

/**
 * Procedural textures. Everything in the office is generated here with the 2D
 * canvas API: no image downloads, tiny bundle, and easy to swap for photo-scanned
 * PBR textures later (just replace a function's return value).
 */

/* ------------------------------ noise helpers ----------------------------- */

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ValueNoise {
  private perm: Float32Array;
  constructor(seed: number, private size = 256) {
    const rnd = mulberry32(seed);
    this.perm = new Float32Array(size * size);
    for (let i = 0; i < this.perm.length; i++) this.perm[i] = rnd();
  }
  private at(x: number, y: number): number {
    const s = this.size;
    return this.perm[(((y % s) + s) % s) * s + (((x % s) + s) % s)];
  }
  sample(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = this.at(x0, y0);
    const b = this.at(x0 + 1, y0);
    const c = this.at(x0, y0 + 1);
    const d = this.at(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  fbm(x: number, y: number, octaves = 4): number {
    let v = 0;
    let amp = 0.5;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
      v += amp * this.sample(x * f, y * f);
      f *= 2;
      amp *= 0.5;
    }
    return v;
  }
}

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function toTexture(c: HTMLCanvasElement, opts: { srgb?: boolean; repeat?: [number, number] } = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (opts.repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...opts.repeat);
  }
  t.anisotropy = 8;
  return t;
}

/** Build a tangent-space normal map from a height function (Sobel filter). */
function normalFromHeight(w: number, h: number, height: (x: number, y: number) => number, strength: number, repeat?: [number, number]): THREE.CanvasTexture {
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const hs = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) hs[y * w + x] = height(x, y);
  const H = (x: number, y: number) => hs[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { srgb: false, repeat });
}

/* -------------------------------- surfaces -------------------------------- */

export interface SurfaceMaps {
  map: THREE.Texture;
  roughnessMap?: THREE.Texture;
  normalMap?: THREE.Texture;
}

/** Light office laminate: pale warm grey with a fine printed wood grain. */
export function deskLaminate(): SurfaceMaps {
  const W = 1024;
  const H = 512;
  const n = new ValueNoise(7);
  const [c, ctx] = canvas(W, H);
  const img = ctx.createImageData(W, H);
  const [rc, rctx] = canvas(W, H);
  const rimg = rctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const warp = n.fbm(x / 260, y / 60, 3) * 5;
      const grain = Math.sin(y * 0.55 + warp * 2.4 + n.sample(x / 40, y / 3) * 1.4);
      const fine = n.sample(x / 2.5, y / 0.8) - 0.5;
      const v = 1 + 0.028 * grain + 0.03 * fine + 0.05 * (n.fbm(x / 400, y / 200) - 0.5);
      const i = (y * W + x) * 4;
      img.data[i] = Math.min(255, 190 * v);
      img.data[i + 1] = Math.min(255, 180 * v);
      img.data[i + 2] = Math.min(255, 164 * v);
      img.data[i + 3] = 255;
      const r = 150 + 30 * (n.fbm(x / 120, y / 120) - 0.5) + 18 * fine;
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = r;
      rimg.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  return {
    map: toTexture(c),
    roughnessMap: toTexture(rc, { srgb: false }),
    normalMap: normalFromHeight(256, 128, (x, y) => n.sample(x / 1.5, y / 0.5) * 0.5, 0.8),
  };
}

/** Woven cubicle-panel fabric. */
export function fabric(base: string, seed = 3): SurfaceMaps {
  const S = 512;
  const n = new ValueNoise(seed);
  const [c, ctx] = canvas(S);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, S, S);
  const img = ctx.getImageData(0, 0, S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const weave = (Math.sin(x * 1.6) * Math.sin(y * 1.6) + 1) * 0.5;
      const v = 0.86 + 0.1 * weave + 0.12 * (n.fbm(x / 20, y / 20) - 0.5) + 0.08 * (n.sample(x * 0.9, y * 0.9) - 0.5);
      const i = (y * S + x) * 4;
      img.data[i] *= v;
      img.data[i + 1] *= v;
      img.data[i + 2] *= v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    map: toTexture(c, { repeat: [3, 2] }),
    normalMap: normalFromHeight(256, 256, (x, y) => Math.sin(x * 1.6) * Math.sin(y * 1.6) * 0.5 + n.sample(x / 3, y / 3) * 0.5, 1.6, [3, 2]),
  };
}

export function carpet(): SurfaceMaps {
  const S = 512;
  const n = new ValueNoise(11);
  const rnd = mulberry32(5);
  const [c, ctx] = canvas(S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const speck = rnd();
      const v = 0.8 + 0.25 * (n.fbm(x / 40, y / 40) - 0.5) + (speck > 0.97 ? 0.35 : speck < 0.03 ? -0.3 : 0);
      const i = (y * S + x) * 4;
      img.data[i] = 52 * v;
      img.data[i + 1] = 57 * v;
      img.data[i + 2] = 68 * v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: toTexture(c, { repeat: [8, 8] }), normalMap: normalFromHeight(128, 128, (x, y) => n.sample(x, y), 2, [16, 16]) };
}

export function ceilingTile(): SurfaceMaps {
  const S = 256;
  const rnd = mulberry32(9);
  const [c, ctx] = canvas(S);
  ctx.fillStyle = '#e9e7e1';
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = 'rgba(80,80,80,0.18)';
  for (let i = 0; i < 1400; i++) ctx.fillRect(rnd() * S, rnd() * S, 1.5, 1.5);
  ctx.strokeStyle = '#b9b6ae';
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, S, S);
  return { map: toTexture(c, { repeat: [1, 1] }) };
}

export function plasticRoughness(): THREE.Texture {
  const S = 256;
  const n = new ValueNoise(21);
  const [c, ctx] = canvas(S);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const x = i % S;
    const y = Math.floor(i / S);
    const v = 150 + 50 * (n.fbm(x / 16, y / 16) - 0.5);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { srgb: false });
}

/* ------------------------------- decorations ------------------------------ */

export function stickyNote(lines: string[], color = '#fdf08a', tilt = 0): THREE.CanvasTexture {
  const S = 256;
  const [c, ctx] = canvas(S);
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, color);
  g.addColorStop(1, shade(color, -0.08));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  ctx.fillRect(0, 0, S, 26);
  ctx.save();
  ctx.translate(S / 2, S / 2);
  ctx.rotate(tilt);
  ctx.fillStyle = '#1f2a5a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const size = lines.length > 3 ? 34 : 42;
  ctx.font = `700 ${size}px ${HAND}`;
  lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * size * 1.05 + 8));
  ctx.restore();
  return toTexture(c);
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + 255 * amt)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

export function cheatSheetPoster(): THREE.CanvasTexture {
  const W = 600;
  const H = 800;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#f4f1e8';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e8573f';
  ctx.fillRect(0, 0, W, 120);
  ctx.fillStyle = '#fff';
  ctx.font = `800 58px ${SANS}`;
  ctx.fillText('GIT CHEAT SHEET', 34, 78);
  ctx.fillStyle = '#2b2b2b';
  const rows: Array<[string, string]> = [
    ['git status', 'what is going on'],
    ['git add <file>', 'stage it'],
    ['git commit -m', 'save a snapshot'],
    ['git switch -c', 'new branch'],
    ['git pull', 'get latest'],
    ['git push', 'share it'],
    ['git log --graph', 'see history'],
    ['git stash', 'hide it for now'],
    ['git reflog', 'undo (almost) anything'],
  ];
  rows.forEach(([cmd, desc], i) => {
    const y = 180 + i * 64;
    ctx.font = `700 30px ${MONO}`;
    ctx.fillStyle = '#1d3b8b';
    ctx.fillText(cmd, 34, y);
    ctx.font = `500 24px ${SANS}`;
    ctx.fillStyle = '#555';
    ctx.fillText(desc, 34, y + 30);
  });
  ctx.fillStyle = '#e8573f';
  ctx.font = `700 30px ${HAND}`;
  ctx.save();
  ctx.translate(360, 760);
  ctx.rotate(-0.08);
  ctx.fillText('NEVER --force !!! - Greg', -60, 0);
  ctx.restore();
  return toTexture(c);
}

export function calendarTexture(month = 'MARCH 2026', highlight = 2): THREE.CanvasTexture {
  const W = 400;
  const H = 480;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#2f6d8f';
  ctx.fillRect(0, 0, W, 190);
  // "Photo": a mountain at sunset (motivational!)
  const g = ctx.createLinearGradient(0, 0, 0, 190);
  g.addColorStop(0, '#f6a15a');
  g.addColorStop(1, '#8f4f7a');
  ctx.fillStyle = g;
  ctx.fillRect(10, 10, W - 20, 170);
  ctx.fillStyle = '#3b2d4f';
  ctx.beginPath();
  ctx.moveTo(10, 180);
  ctx.lineTo(140, 60);
  ctx.lineTo(230, 140);
  ctx.lineTo(300, 90);
  ctx.lineTo(W - 10, 180);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `800 22px ${SANS}`;
  ctx.fillText('SYNERGY', 24, 40);
  ctx.fillStyle = '#222';
  ctx.font = `800 30px ${SANS}`;
  ctx.fillText(month, 24, 230);
  ctx.font = `600 20px ${SANS}`;
  const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  days.forEach((d, i) => ctx.fillText(d, 30 + i * 52, 268));
  for (let d = 1; d <= 31; d++) {
    const idx = d + 6; // March 1 2026 is a Sunday
    const col = idx % 7;
    const row = Math.floor(idx / 7) - 1;
    const x = 30 + col * 52;
    const y = 304 + row * 36;
    if (d === highlight) {
      ctx.strokeStyle = '#e03a3a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x + 9, y - 7, 17, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = col === 0 || col === 6 ? '#999' : '#333';
    ctx.fillText(String(d), x, y);
  }
  return toTexture(c);
}

export function catPhoto(): THREE.CanvasTexture {
  const W = 300;
  const H = 240;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#f2efe6';
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#9fc4d8');
  g.addColorStop(1, '#d9c7a4');
  ctx.fillStyle = g;
  ctx.fillRect(14, 14, W - 28, H - 28);
  // A cat, sitting judgmentally.
  ctx.fillStyle = '#3a3434';
  ctx.beginPath();
  ctx.ellipse(150, 170, 62, 50, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(150, 104, 38, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(118, 88);
  ctx.lineTo(124, 52);
  ctx.lineTo(140, 74);
  ctx.moveTo(182, 88);
  ctx.lineTo(176, 52);
  ctx.lineTo(160, 74);
  ctx.fill();
  ctx.fillStyle = '#d7e36a';
  ctx.beginPath();
  ctx.ellipse(136, 102, 7, 5, 0, 0, Math.PI * 2);
  ctx.ellipse(164, 102, 7, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.fillRect(135, 98, 2, 8);
  ctx.fillRect(163, 98, 2, 8);
  return toTexture(c);
}

export function certificate(name: string): THREE.CanvasTexture {
  const W = 420;
  const H = 300;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#fbf7ea';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#b8903a';
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, W - 28, H - 28);
  ctx.fillStyle = '#6b4e12';
  ctx.textAlign = 'center';
  ctx.font = `800 24px ${SANS}`;
  ctx.fillText('CERTIFICATE OF', W / 2, 70);
  ctx.fillText('SUCCESSFUL ONBOARDING', W / 2, 100);
  ctx.font = `700 34px ${HAND}`;
  ctx.fillStyle = '#1f2a5a';
  ctx.fillText(name, W / 2, 160);
  ctx.font = `500 16px ${SANS}`;
  ctx.fillStyle = '#6b4e12';
  ctx.fillText('has completed Mandatory Fun Training (Module 1 of 14)', W / 2, 210);
  ctx.font = `700 22px ${HAND}`;
  ctx.fillText('— PeopleOps', W / 2 + 80, 255);
  return toTexture(c);
}

export function nameplate(name: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 128);
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#d8d9dc');
  g.addColorStop(1, '#a9abb0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = '#23252b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 44px ${SANS}`;
  ctx.fillText(name.toUpperCase().slice(0, 20), 256, 52);
  ctx.font = `500 22px ${SANS}`;
  ctx.fillText('Junior Developer · Desk 4B', 256, 98);
  return toTexture(c);
}

export function mugLabel(): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 256);
  ctx.fillStyle = '#f7f5f0';
  ctx.fillRect(0, 0, 1024, 256);
  ctx.fillStyle = '#2b3a67';
  ctx.textAlign = 'center';
  ctx.font = `800 54px ${SANS}`;
  ctx.fillText("WORLD'S OKAYEST", 300, 110);
  ctx.fillText('DEVELOPER', 300, 175);
  ctx.font = `700 64px ${MONO}`;
  ctx.fillStyle = '#e8573f';
  ctx.fillText('git gud', 780, 150);
  return toTexture(c);
}

/* --------------------------------- skyline -------------------------------- */

export interface SkyPalette {
  top: string;
  bottom: string;
  night: number; // 0..1 how lit the windows are
  sun: string | null;
  sunY: number;
}

export function skyForHour(h: number): SkyPalette {
  if (h < 6.5) return { top: '#060b1c', bottom: '#1b2a4a', night: 1, sun: null, sunY: 0 };
  if (h < 8) return { top: '#3b4f86', bottom: '#f3a36b', night: 0.5, sun: '#ffd29a', sunY: 0.82 };
  if (h < 16) return { top: '#5d8fd0', bottom: '#cfe3f2', night: 0.05, sun: null, sunY: 0 };
  if (h < 17.5) return { top: '#6c86c2', bottom: '#f6c27a', night: 0.2, sun: '#ffe0a0', sunY: 0.7 };
  if (h < 19.5) return { top: '#2c2e62', bottom: '#e57a5b', night: 0.7, sun: '#ff9c6b', sunY: 0.9 };
  return { top: '#050918', bottom: '#172444', night: 1, sun: null, sunY: 0 };
}

export function skylineTexture(hour: number): THREE.CanvasTexture {
  const W = 2048;
  const H = 512;
  const [c, ctx] = canvas(W, H);
  const pal = skyForHour(hour);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, pal.top);
  g.addColorStop(1, pal.bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (pal.sun) {
    const sg = ctx.createRadialGradient(W * 0.72, H * pal.sunY, 10, W * 0.72, H * pal.sunY, 260);
    sg.addColorStop(0, pal.sun);
    sg.addColorStop(1, 'rgba(255,200,150,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, W, H);
  }
  const rnd = mulberry32(42);
  const layers = [
    { color: hour > 19 || hour < 6.5 ? '#0e1426' : '#6f7f96', min: 120, max: 260, alpha: 0.8 },
    { color: hour > 19 || hour < 6.5 ? '#0a0f1d' : '#4b5a70', min: 180, max: 380, alpha: 1 },
  ];
  for (const layer of layers) {
    let x = -20;
    while (x < W) {
      const bw = 60 + rnd() * 140;
      const bh = layer.min + rnd() * (layer.max - layer.min);
      ctx.globalAlpha = layer.alpha;
      ctx.fillStyle = layer.color;
      ctx.fillRect(x, H - bh, bw, bh);
      // Windows
      for (let wy = H - bh + 14; wy < H - 10; wy += 18) {
        for (let wx = x + 8; wx < x + bw - 10; wx += 16) {
          const lit = rnd() < 0.12 + 0.55 * pal.night;
          if (!lit) continue;
          ctx.fillStyle = rnd() > 0.2 ? `rgba(255,${210 + rnd() * 40},${140 + rnd() * 60},${0.35 + 0.6 * pal.night})` : 'rgba(170,210,255,0.6)';
          ctx.fillRect(wx, wy, 7, 9);
        }
      }
      x += bw + rnd() * 10;
    }
  }
  ctx.globalAlpha = 1;
  return toTexture(c);
}

export function keycapAtlas(labels: string[]): { texture: THREE.CanvasTexture; cols: number; rows: number } {
  const cols = 12;
  const rows = Math.ceil(labels.length / cols);
  const cell = 64;
  const [c, ctx] = canvas(cols * cell, rows * cell);
  ctx.fillStyle = '#2a2d33';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#c9ccd3';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  labels.forEach((l, i) => {
    const x = (i % cols) * cell + cell / 2;
    const y = Math.floor(i / cols) * cell + cell / 2;
    ctx.font = `600 ${l.length > 2 ? 15 : 26}px ${SANS}`;
    ctx.fillText(l, x, y);
  });
  return { texture: toTexture(c), cols, rows };
}
