/** Colors and fonts shared by the in-world screens (drawn on canvases). */

// IBM Plex Mono has no programming ligatures, so `->` in git output stays `->`.
export const MONO = '"IBM Plex Mono", "DejaVu Sans Mono", Menlo, Consolas, "Liberation Mono", monospace';
export const SANS = '"IBM Plex Sans", "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
export const HAND = '"Caveat", "Comic Sans MS", "Segoe Print", cursive';

/** A calm, readable terminal palette (roughly Tomorrow Night). */
export const TERM = {
  bg: '#12151c',
  bgTop: '#1a1f29',
  fg: '#d5dbe3',
  dimFg: '#7c8594',
  cursor: '#e8e8e8',
  selection: '#2a3242',
  titleBar: '#232936',
  titleFg: '#aab3c2',
  palette: {
    black: '#1d1f21',
    red: '#f0616d',
    green: '#9fd36a',
    yellow: '#f5c16c',
    blue: '#6fb3f2',
    magenta: '#c792ea',
    cyan: '#6fd6d6',
    white: '#d5dbe3',
    gray: '#7c8594',
    brightRed: '#ff7b86',
    brightGreen: '#b5e890',
    brightYellow: '#ffd68a',
    brightBlue: '#8cc4ff',
    brightMagenta: '#dbaef5',
    brightCyan: '#8fe8e8',
    brightWhite: '#ffffff',
  } as Record<string, string>,
};

export const CHAT = {
  sidebar: '#1b2030',
  sidebarHover: '#262c40',
  sidebarActive: '#3a57c9',
  sidebarFg: '#c3c9d8',
  sidebarDim: '#7f879b',
  main: '#f7f7f9',
  mainFg: '#1d1f24',
  mainDim: '#6b7080',
  border: '#e2e3e8',
  codeBg: '#eceef3',
  codeFg: '#c2185b',
  accent: '#3a57c9',
  panel: '#ffffff',
  green: '#2bb38a',
  badge: '#e8517a',
};

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Split text into lines no wider than maxWidth (proportional fonts). */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (ctx.measureText(test).width > maxWidth && line.trim()) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}
