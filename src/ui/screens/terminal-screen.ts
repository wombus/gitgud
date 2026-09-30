import { expandTabs, parseAnsi, wrapSpans, type Span } from '../ansi-spans';
import { NANO_HELP, NANO_SHORTCUTS, type NanoEditor } from '../nano';
import type { TerminalModel } from '../terminal-model';
import { MONO, SANS, TERM, roundRect, wrapText } from './theme';

/**
 * Draws the terminal (or nano) onto a canvas that becomes the monitor's screen
 * texture. Rendering only happens when something changed, because every redraw
 * means re-uploading a large texture to the GPU.
 */

export interface Toast {
  id: number;
  name: string;
  initials: string;
  color: string;
  text: string;
  born: number;
}

const TITLE_H = 46;
const PAD_X = 22;
const PAD_Y = 14;
const TOAST_LIFE = 7000;

export class TerminalScreen {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  fontSize = 25;
  lineHeight = 32;
  private charW = 15;
  cols = 80;
  rows = 24;
  editor: NanoEditor | null = null;
  title = 'zsh';
  clock = '';
  ticket = '';
  toasts: Toast[] = [];
  /** Screen is off (title screen / between levels). */
  off = false;
  bootLines: string[] | null = null;
  private lastKey = '';
  private blinkOn = true;

  constructor(
    public model: TerminalModel,
    public width = 1920,
    public height = 1080,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d')!;
    this.setFontSize(this.fontSize);
  }

  setFontSize(px: number): void {
    this.fontSize = px;
    this.lineHeight = Math.round(px * 1.3);
    this.ctx.font = `${px}px ${MONO}`;
    this.charW = this.ctx.measureText('M').width;
    this.cols = Math.floor((this.width - PAD_X * 2) / this.charW);
    this.rows = Math.floor((this.height - TITLE_H - PAD_Y * 2) / this.lineHeight);
    this.lastKey = '';
  }

  pushToast(t: Omit<Toast, 'id' | 'born'>, now: number): void {
    this.toasts.push({ ...t, id: now + Math.random(), born: now });
    if (this.toasts.length > 3) this.toasts.shift();
    this.lastKey = '';
  }

  /** Total wrapped rows available for scrolling (for scroll clamping). */
  maxScroll(): number {
    return Math.max(0, this.model.scrollback.length * 2);
  }

  /** Redraw if needed. Returns true when the canvas content changed. */
  render(now: number): boolean {
    this.toasts = this.toasts.filter((t) => now - t.born < TOAST_LIFE);
    const blink = Math.floor(now / 530) % 2 === 0;
    const animatingToast = this.toasts.some((t) => now - t.born < 400 || TOAST_LIFE - (now - t.born) < 400);
    const key = [
      this.off,
      this.model.version,
      this.editor?.version ?? -1,
      this.editor ? 'E' : 'T',
      blink,
      this.title,
      this.clock,
      this.ticket,
      this.toasts.map((t) => t.id).join(','),
      this.bootLines?.length ?? -1,
    ].join('|');
    if (key === this.lastKey && !animatingToast) return false;
    this.lastKey = key;
    this.blinkOn = blink;

    const ctx = this.ctx;
    if (this.off) {
      ctx.fillStyle = '#050608';
      ctx.fillRect(0, 0, this.width, this.height);
      return true;
    }
    // Background with a faint vertical gradient (screens aren't perfectly uniform).
    const g = ctx.createLinearGradient(0, 0, 0, this.height);
    g.addColorStop(0, TERM.bgTop);
    g.addColorStop(1, TERM.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawTitleBar();
    if (this.bootLines) this.drawBoot();
    else if (this.editor) this.drawNano(this.editor);
    else this.drawTerminal();
    this.drawToasts(now);
    return true;
  }

  private drawTitleBar(): void {
    const ctx = this.ctx;
    ctx.fillStyle = TERM.titleBar;
    ctx.fillRect(0, 0, this.width, TITLE_H);
    ctx.fillStyle = '#0c0e13';
    ctx.fillRect(0, TITLE_H - 1, this.width, 1);
    // Window buttons
    const dots = ['#e0605a', '#e8b84a', '#5fbf5a'];
    dots.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(26 + i * 26, TITLE_H / 2, 8, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.font = `600 ${20}px ${SANS}`;
    ctx.fillStyle = TERM.titleFg;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(this.editor ? `nano ${this.editor.filename}` : this.title, this.width / 2, TITLE_H / 2 + 1);
    ctx.textAlign = 'right';
    ctx.font = `500 ${19}px ${SANS}`;
    ctx.fillText([this.ticket, this.clock].filter(Boolean).join('   ·   '), this.width - 22, TITLE_H / 2 + 1);
    ctx.textAlign = 'left';
  }

  private drawSpans(spans: Span[], x: number, y: number, defaultColor = TERM.fg): void {
    const ctx = this.ctx;
    let cx = x;
    for (const s of spans) {
      const weight = s.style.bold ? 'bold ' : '';
      ctx.font = `${weight}${this.fontSize}px ${MONO}`;
      let color = s.style.fg ? TERM.palette[s.style.fg] ?? defaultColor : defaultColor;
      if (s.style.dim) color = TERM.dimFg;
      ctx.fillStyle = color;
      ctx.fillText(s.text, cx, y);
      cx += [...s.text].length * this.charW;
    }
  }

  private drawTerminal(): void {
    const ctx = this.ctx;
    const m = this.model;
    ctx.textBaseline = 'top';
    const top = TITLE_H + PAD_Y;

    // Build the visible rows from the bottom up: input line(s) first, then scrollback.
    const promptSpans = expandTabs(parseAnsi(m.prompt));
    const promptLen = promptSpans.reduce((n, s) => n + [...s.text].length, 0);
    const inputSpans: Span[] = m.busy ? [] : [...promptSpans, { text: m.input, style: { fg: null, bold: false, dim: false } }];
    const inputRows = m.busy ? [] : wrapSpans(inputSpans, this.cols);
    const needed = this.rows + m.scroll;
    const rowsFromScrollback: Span[][] = [];
    for (let i = m.scrollback.length - 1; i >= 0 && rowsFromScrollback.length < needed; i--) {
      const wrapped = wrapSpans(expandTabs(parseAnsi(m.scrollback[i])), this.cols);
      rowsFromScrollback.unshift(...wrapped);
    }
    const all = [...rowsFromScrollback, ...inputRows];
    // Like a real terminal: fill from the top until the screen is full, then scroll.
    let start = Math.max(0, all.length - this.rows - m.scroll);
    if (all.length <= this.rows) start = 0;
    const visible = all.slice(start, start + this.rows);
    visible.forEach((row, i) => this.drawSpans(row, PAD_X, top + i * this.lineHeight + (this.lineHeight - this.fontSize) / 2));

    // Cursor
    if (!m.busy && m.scroll === 0 && this.blinkOn) {
      const pos = promptLen + m.cursor;
      const rowInInput = Math.floor(pos / this.cols);
      const colInRow = pos % this.cols;
      const absRow = rowsFromScrollback.length + rowInInput - start;
      if (absRow >= 0 && absRow < this.rows) {
        const x = PAD_X + colInRow * this.charW;
        const y = top + absRow * this.lineHeight;
        ctx.fillStyle = TERM.cursor;
        ctx.fillRect(x, y + 2, this.charW, this.lineHeight - 4);
        const ch = m.input[m.cursor];
        if (ch) {
          ctx.fillStyle = TERM.bg;
          ctx.font = `${this.fontSize}px ${MONO}`;
          ctx.fillText(ch, x, y + (this.lineHeight - this.fontSize) / 2);
        }
      }
    }
    if (m.scroll > 0) {
      ctx.fillStyle = 'rgba(111,179,242,0.85)';
      roundRect(ctx, this.width - 210, this.height - 52, 190, 36, 8);
      ctx.fill();
      ctx.fillStyle = '#0b0d12';
      ctx.font = `600 18px ${SANS}`;
      ctx.fillText(`↑ scrolled (${m.scroll})`, this.width - 196, this.height - 44);
    }
  }

  private drawNano(ed: NanoEditor): void {
    const ctx = this.ctx;
    ctx.textBaseline = 'top';
    const top = TITLE_H;
    const lh = this.lineHeight;
    const off = (lh - this.fontSize) / 2;
    const textRows = this.rows - 4; // header + status + 2 shortcut rows
    ed.ensureVisible(textRows);

    // Header bar (inverse video)
    ctx.fillStyle = '#d5dbe3';
    ctx.fillRect(0, top + 4, this.width, lh);
    ctx.fillStyle = '#12151c';
    ctx.font = `${this.fontSize}px ${MONO}`;
    ctx.fillText('  GNU nano 7.2', PAD_X, top + 4 + off);
    const name = ed.filename;
    ctx.fillText(name, (this.width - [...name].length * this.charW) / 2, top + 4 + off);
    if (ed.modified) ctx.fillText('Modified  ', this.width - 12 * this.charW, top + 4 + off);

    const bodyTop = top + 4 + lh + 6;
    if (ed.mode === 'help') {
      NANO_HELP.forEach((l, i) => this.drawSpans([{ text: l, style: { fg: i === 0 ? 'brightWhite' : null, bold: i === 0, dim: false } }], PAD_X, bodyTop + i * lh + off));
    } else {
      for (let i = 0; i < textRows; i++) {
        const lineNo = ed.top + i;
        if (lineNo >= ed.lines.length) break;
        const raw = ed.lines[lineNo];
        const shown = [...raw].slice(0, this.cols).join('');
        let color: string | null = null;
        if (/^(<{7}|={7}|>{7})/.test(raw)) color = 'brightRed';
        else if (raw.startsWith('#')) color = 'gray';
        this.drawSpans([{ text: shown, style: { fg: color, bold: /^(<{7}|={7}|>{7})/.test(raw), dim: false } }], PAD_X, bodyTop + i * lh + off);
      }
      // Cursor
      if (ed.mode === 'edit' && this.blinkOn) {
        const cy = bodyTop + (ed.row - ed.top) * lh;
        const cx = PAD_X + Math.min(ed.col, this.cols - 1) * this.charW;
        ctx.fillStyle = TERM.cursor;
        ctx.fillRect(cx, cy + 2, this.charW, lh - 4);
        const ch = ed.lines[ed.row][ed.col];
        if (ch) {
          ctx.fillStyle = TERM.bg;
          ctx.font = `${this.fontSize}px ${MONO}`;
          ctx.fillText(ch, cx, cy + off);
        }
      }
    }

    // Status / prompt line
    const statusY = this.height - PAD_Y - lh * 3;
    ctx.font = `${this.fontSize}px ${MONO}`;
    if (ed.mode === 'write-prompt' || ed.mode === 'exit-write-prompt') {
      ctx.fillStyle = '#d5dbe3';
      ctx.fillRect(0, statusY, this.width, lh);
      ctx.fillStyle = '#12151c';
      const label = `File Name to Write: ${ed.promptInput}`;
      ctx.fillText(label, PAD_X, statusY + off);
      if (this.blinkOn) ctx.fillRect(PAD_X + [...label].length * this.charW, statusY + 2, this.charW, lh - 4);
    } else if (ed.mode === 'exit-prompt') {
      ctx.fillStyle = '#d5dbe3';
      ctx.fillRect(0, statusY, this.width, lh);
      ctx.fillStyle = '#12151c';
      ctx.fillText('Save modified buffer?  (Y = yes, N = no, ^C = cancel)', PAD_X, statusY + off);
    } else if (ed.status) {
      const w = [...ed.status].length * this.charW + 24;
      ctx.fillStyle = '#d5dbe3';
      ctx.fillRect((this.width - w) / 2, statusY, w, lh);
      ctx.fillStyle = '#12151c';
      ctx.fillText(ed.status, (this.width - w) / 2 + 12, statusY + off);
    }

    // Shortcut rows
    const sy = this.height - PAD_Y - lh * 2;
    const shortcuts =
      ed.mode === 'exit-prompt'
        ? ([
            [' Y', 'Yes'],
            [' N', 'No'],
            ['^C', 'Cancel'],
          ] as Array<[string, string]>)
        : ed.mode === 'write-prompt' || ed.mode === 'exit-write-prompt'
          ? ([
              ['↵', 'Confirm'],
              ['^C', 'Cancel'],
            ] as Array<[string, string]>)
          : NANO_SHORTCUTS;
    const colW = Math.floor(this.width / 6);
    shortcuts.forEach(([k, label], i) => {
      const x = PAD_X + (i % 6) * colW;
      const y = sy + Math.floor(i / 6) * lh;
      ctx.fillStyle = '#d5dbe3';
      ctx.fillRect(x, y + 2, [...k].length * this.charW + 4, lh - 4);
      ctx.fillStyle = '#12151c';
      ctx.fillText(k, x + 2, y + off);
      ctx.fillStyle = TERM.fg;
      ctx.fillText(label, x + ([...k].length + 1) * this.charW + 4, y + off);
    });
  }

  private drawBoot(): void {
    const top = TITLE_H + PAD_Y;
    (this.bootLines ?? []).slice(-this.rows).forEach((l, i) => {
      this.drawSpans(expandTabs(parseAnsi(l)), PAD_X, top + i * this.lineHeight + (this.lineHeight - this.fontSize) / 2);
    });
  }

  private drawToasts(now: number): void {
    const ctx = this.ctx;
    const w = 620;
    let y = TITLE_H + 18;
    for (const t of [...this.toasts].reverse()) {
      const age = now - t.born;
      const inT = Math.min(1, age / 320);
      const outT = Math.min(1, (TOAST_LIFE - age) / 400);
      const ease = (x: number) => 1 - Math.pow(1 - x, 3);
      const slide = (1 - ease(inT)) * (w + 40);
      const alpha = Math.max(0, Math.min(1, outT));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `${22}px ${SANS}`;
      const lines = wrapText(ctx, t.text.replace(/`/g, ''), w - 120).slice(0, 3);
      const h = 64 + lines.length * 29;
      const x = this.width - w - 20 + slide;
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = 'rgba(245,246,250,0.97)';
      roundRect(ctx, x, y, w, h, 16);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      // Avatar
      ctx.fillStyle = t.color;
      roundRect(ctx, x + 18, y + 18, 60, 60, 12);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${24}px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.initials, x + 48, y + 49);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#15171c';
      ctx.font = `700 ${22}px ${SANS}`;
      ctx.fillText(t.name, x + 96, y + 16);
      ctx.fillStyle = '#7a7f8c';
      ctx.font = `500 ${17}px ${SANS}`;
      ctx.fillText('Pingr · now', x + w - 130, y + 19);
      ctx.fillStyle = '#2b2e36';
      ctx.font = `${22}px ${SANS}`;
      lines.forEach((l, i) => ctx.fillText(l, x + 96, y + 48 + i * 29));
      ctx.restore();
      y += h + 14;
    }
  }
}
