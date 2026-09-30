import type { ChatMessage, ObjectiveStatus } from '../../game/director';
import { character, type CharacterId } from '../../game/characters';
import { clockTime } from '../../engine/util';
import { CHAT, MONO, SANS, roundRect } from './theme';

/**
 * "Pingr", the company chat app, drawn on the second monitor. Coworkers' IMs
 * land in #eng-team; the right-hand panel shows the current ticket.
 */

const SIDEBAR_W = 330;
const PANEL_W = 460;
const HEADER_H = 84;

interface Seg {
  text: string;
  code: boolean;
}

function segments(text: string): Seg[] {
  const parts = text.split('`');
  return parts.map((t, i) => ({ text: t, code: i % 2 === 1 })).filter((s) => s.text);
}

export class ChatScreen {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  messages: ChatMessage[] = [];
  typing: CharacterId | null = null;
  objectives: ObjectiveStatus[] = [];
  ticket = { id: '', title: '', summary: '' };
  off = false;
  private lastKey = '';
  private layoutCache = new Map<number, { lines: Array<Array<{ text: string; code: boolean; x: number }>>; height: number }>();

  constructor(
    public width = 1920,
    public height = 1080,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d')!;
  }

  reset(): void {
    this.messages = [];
    this.layoutCache.clear();
    this.typing = null;
    this.lastKey = '';
  }

  render(now: number): boolean {
    const dots = this.typing ? Math.floor(now / 350) % 4 : 0;
    const key = [this.off, this.messages.length, this.typing, dots, JSON.stringify(this.objectives), this.ticket.id].join('|');
    if (key === this.lastKey) return false;
    this.lastKey = key;
    const ctx = this.ctx;
    if (this.off) {
      ctx.fillStyle = '#050608';
      ctx.fillRect(0, 0, this.width, this.height);
      return true;
    }
    ctx.textBaseline = 'top';
    this.drawSidebar();
    this.drawMain(dots);
    this.drawPanel();
    return true;
  }

  private drawSidebar(): void {
    const ctx = this.ctx;
    ctx.fillStyle = CHAT.sidebar;
    ctx.fillRect(0, 0, SIDEBAR_W, this.height);
    // Brand
    ctx.fillStyle = '#fff';
    ctx.font = `800 34px ${SANS}`;
    ctx.fillText('Conglomo', 28, 26);
    ctx.fillStyle = CHAT.sidebarDim;
    ctx.font = `500 19px ${SANS}`;
    ctx.fillText('Pingr · Enterprise Edition', 28, 68);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, 104, SIDEBAR_W, 1);

    let y = 126;
    const section = (title: string) => {
      ctx.fillStyle = CHAT.sidebarDim;
      ctx.font = `700 17px ${SANS}`;
      ctx.fillText(title.toUpperCase(), 28, y);
      y += 34;
    };
    const item = (label: string, opts: { active?: boolean; unread?: number; presence?: string; bold?: boolean } = {}) => {
      if (opts.active) {
        ctx.fillStyle = CHAT.sidebarActive;
        roundRect(ctx, 14, y - 8, SIDEBAR_W - 28, 44, 8);
        ctx.fill();
      }
      let x = 32;
      if (opts.presence) {
        ctx.fillStyle = opts.presence;
        ctx.beginPath();
        ctx.arc(x + 6, y + 14, 7, 0, Math.PI * 2);
        ctx.fill();
        x += 24;
      }
      ctx.fillStyle = opts.active ? '#fff' : opts.bold ? '#fff' : CHAT.sidebarFg;
      ctx.font = `${opts.active || opts.bold ? 700 : 500} 22px ${SANS}`;
      ctx.fillText(label, x, y);
      if (opts.unread) {
        ctx.fillStyle = CHAT.badge;
        roundRect(ctx, SIDEBAR_W - 72, y - 2, 42, 30, 15);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `700 17px ${SANS}`;
        ctx.textAlign = 'center';
        ctx.fillText(String(opts.unread), SIDEBAR_W - 51, y + 4);
        ctx.textAlign = 'left';
      }
      y += 48;
    };
    section('Channels');
    item('# eng-team', { active: true });
    item('# incidents', { bold: this.messages.some((m) => m.from === 'priya') });
    item('# deploys');
    item('# random', { unread: 3, bold: true });
    item('# announcements', { unread: 1, bold: true });
    y += 14;
    section('Direct messages');
    const presence = { online: '#2bb38a', away: '#9aa0ad', dnd: '#e0605a' } as const;
    for (const id of ['dana', 'greg', 'priya', 'todd', 'marcus'] as CharacterId[]) {
      const ch = character(id);
      item(ch.name, { presence: presence[ch.status] });
    }
    // Footer: you
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, this.height - 92, SIDEBAR_W, 1);
    ctx.fillStyle = '#4b5a86';
    roundRect(ctx, 26, this.height - 72, 52, 52, 10);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 22px ${SANS}`;
    ctx.fillText('JD', 36, this.height - 58);
    ctx.fillStyle = '#fff';
    ctx.font = `700 20px ${SANS}`;
    ctx.fillText('junior-dev (you)', 92, this.height - 72);
    ctx.fillStyle = CHAT.sidebarDim;
    ctx.font = `500 17px ${SANS}`;
    ctx.fillText('🟢 Replying via terminal only', 92, this.height - 44);
  }

  private layoutMessage(m: ChatMessage, maxW: number) {
    const cached = this.layoutCache.get(m.id);
    if (cached) return cached;
    const ctx = this.ctx;
    const lines: Array<Array<{ text: string; code: boolean; x: number }>> = [[]];
    let x = 0;
    const put = (text: string, code: boolean) => {
      ctx.font = code ? `22px ${MONO}` : `24px ${SANS}`;
      const w = ctx.measureText(text).width + (code ? 12 : 0);
      if (x + w > maxW && x > 0) {
        lines.push([]);
        x = 0;
        text = text.replace(/^\s+/, '');
      }
      lines[lines.length - 1].push({ text, code, x });
      x += ctx.measureText(text).width + (code ? 12 : 0);
    };
    for (const para of m.text.split('\n').map((p, i) => ({ p, i }))) {
      if (para.i > 0) {
        lines.push([]);
        x = 0;
      }
      for (const seg of segments(para.p)) {
        if (seg.code) {
          put(seg.text, true);
        } else {
          for (const w of seg.text.split(/(\s+)/)) if (w) put(w, false);
        }
      }
    }
    const res = { lines, height: lines.length * 34 };
    this.layoutCache.set(m.id, res);
    return res;
  }

  private drawMain(dots: number): void {
    const ctx = this.ctx;
    const x0 = SIDEBAR_W;
    const w = this.width - SIDEBAR_W - PANEL_W;
    ctx.fillStyle = CHAT.main;
    ctx.fillRect(x0, 0, w, this.height);
    // Header
    ctx.fillStyle = '#fff';
    ctx.fillRect(x0, 0, w, HEADER_H);
    ctx.fillStyle = CHAT.border;
    ctx.fillRect(x0, HEADER_H - 1, w, 1);
    ctx.fillStyle = CHAT.mainFg;
    ctx.font = `800 30px ${SANS}`;
    ctx.fillText('# eng-team', x0 + 32, 18);
    ctx.fillStyle = CHAT.mainDim;
    ctx.font = `500 19px ${SANS}`;
    ctx.fillText('Ship it. (Carefully.)  ·  5 members  ·  📌 “never force push to main”', x0 + 34, 54);

    // Messages, bottom-anchored
    const composerH = 110;
    const bottom = this.height - composerH - (this.typing ? 40 : 12);
    const textX = x0 + 112;
    const textW = w - 150;
    interface Block {
      m: ChatMessage;
      header: boolean;
      h: number;
    }
    const blocks: Block[] = [];
    this.messages.forEach((m, i) => {
      const prev = this.messages[i - 1];
      const header = !prev || prev.from !== m.from || m.time - prev.time > 120;
      const lay = this.layoutMessage(m, textW);
      blocks.push({ m, header, h: lay.height + (header ? 44 : 10) });
    });
    let y = bottom;
    const visible: Array<Block & { y: number }> = [];
    for (let i = blocks.length - 1; i >= 0 && y > HEADER_H; i--) {
      y -= blocks[i].h;
      visible.unshift({ ...blocks[i], y });
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, HEADER_H, w, this.height - HEADER_H - composerH);
    ctx.clip();
    if (!this.messages.length) {
      ctx.fillStyle = CHAT.mainDim;
      ctx.font = `500 24px ${SANS}`;
      ctx.fillText('This is the very beginning of #eng-team.', x0 + 40, bottom - 40);
    }
    for (const b of visible) {
      const ch = character(b.m.from);
      let ty = b.y;
      if (b.header) {
        ctx.fillStyle = ch.color;
        roundRect(ctx, x0 + 32, ty + 6, 62, 62, 12);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `700 24px ${SANS}`;
        ctx.textAlign = 'center';
        ctx.fillText(ch.initials, x0 + 63, ty + 23);
        ctx.textAlign = 'left';
        ctx.fillStyle = CHAT.mainFg;
        ctx.font = `800 24px ${SANS}`;
        ctx.fillText(ch.name, textX, ty + 4);
        const nameW = ctx.measureText(ch.name).width;
        ctx.fillStyle = CHAT.mainDim;
        ctx.font = `500 18px ${SANS}`;
        ctx.fillText(`${ch.title}  ·  ${clockTime(b.m.time)}`, textX + nameW + 14, ty + 9);
        ty += 38;
      }
      const lay = this.layoutMessage(b.m, textW);
      lay.lines.forEach((line, li) => {
        for (const part of line) {
          const px = textX + part.x;
          const py = ty + li * 34;
          if (part.code) {
            ctx.font = `22px ${MONO}`;
            const tw = ctx.measureText(part.text).width;
            ctx.fillStyle = CHAT.codeBg;
            roundRect(ctx, px, py + 1, tw + 10, 30, 6);
            ctx.fill();
            ctx.fillStyle = CHAT.codeFg;
            ctx.fillText(part.text, px + 5, py + 5);
          } else {
            ctx.font = `24px ${SANS}`;
            ctx.fillStyle = '#2a2d35';
            ctx.fillText(part.text, px, py + 2);
          }
        }
      });
    }
    ctx.restore();

    if (this.typing) {
      const ch = character(this.typing);
      ctx.fillStyle = CHAT.mainDim;
      ctx.font = `italic 500 20px ${SANS}`;
      ctx.fillText(`${ch.name} is typing${'.'.repeat(dots)}`, x0 + 40, this.height - composerH - 34);
    }
    // Composer
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#c9ccd6';
    ctx.lineWidth = 2;
    roundRect(ctx, x0 + 28, this.height - composerH + 10, w - 56, 76, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#a0a4b0';
    ctx.font = `500 22px ${SANS}`;
    ctx.fillText('Message #eng-team  (IT policy: replies are disabled; do the work in the terminal)', x0 + 50, this.height - composerH + 36);
  }

  private drawPanel(): void {
    const ctx = this.ctx;
    const x0 = this.width - PANEL_W;
    ctx.fillStyle = '#eef0f5';
    ctx.fillRect(x0, 0, PANEL_W, this.height);
    ctx.fillStyle = CHAT.border;
    ctx.fillRect(x0, 0, 1, this.height);
    ctx.fillStyle = CHAT.mainFg;
    ctx.font = `800 26px ${SANS}`;
    ctx.fillText('Your ticket', x0 + 28, 26);

    const cx = x0 + 22;
    const cw = PANEL_W - 44;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.08)';
    ctx.shadowBlur = 12;
    const cardH = Math.min(this.height - 110, 190 + this.objectives.length * 76);
    roundRect(ctx, cx, 76, cw, cardH, 14);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    let y = 96;
    ctx.fillStyle = CHAT.accent;
    ctx.font = `700 19px ${MONO}`;
    ctx.fillText(this.ticket.id || '—', cx + 22, y);
    const done = this.objectives.length > 0 && this.objectives.every((o) => o.done);
    const badge = done ? 'Done' : 'In Progress';
    ctx.font = `700 16px ${SANS}`;
    const bw = ctx.measureText(badge).width + 22;
    ctx.fillStyle = done ? '#d9f5e9' : '#fff3d6';
    roundRect(ctx, cx + cw - bw - 20, y - 4, bw, 30, 15);
    ctx.fill();
    ctx.fillStyle = done ? '#157a55' : '#9a6a00';
    ctx.fillText(badge, cx + cw - bw - 9, y + 2);
    y += 36;
    ctx.fillStyle = CHAT.mainFg;
    ctx.font = `800 26px ${SANS}`;
    for (const l of this.wrap(this.ticket.title, cw - 44).slice(0, 2)) {
      ctx.fillText(l, cx + 22, y);
      y += 34;
    }
    y += 10;
    ctx.fillStyle = CHAT.border;
    ctx.fillRect(cx + 22, y, cw - 44, 1);
    y += 18;
    ctx.font = `600 17px ${SANS}`;
    ctx.fillStyle = CHAT.mainDim;
    ctx.fillText('CHECKLIST', cx + 22, y);
    y += 32;
    for (const o of this.objectives) {
      ctx.strokeStyle = o.done ? CHAT.green : '#b9bdc9';
      ctx.fillStyle = o.done ? CHAT.green : '#fff';
      ctx.lineWidth = 2.5;
      roundRect(ctx, cx + 22, y + 2, 28, 28, 7);
      ctx.fill();
      ctx.stroke();
      if (o.done) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(cx + 29, y + 16);
        ctx.lineTo(cx + 34, y + 23);
        ctx.lineTo(cx + 44, y + 9);
        ctx.stroke();
      }
      ctx.font = `${o.done ? 500 : 600} 21px ${SANS}`;
      ctx.fillStyle = o.done ? '#8a8f9c' : CHAT.mainFg;
      const lines = this.wrap(o.text.replace(/`/g, ''), cw - 100).slice(0, 3);
      lines.forEach((l, i) => ctx.fillText(l, cx + 64, y + 3 + i * 27));
      if (o.done) {
        ctx.fillStyle = '#8a8f9c';
        ctx.fillRect(cx + 64, y + 16, Math.min(cw - 100, ctx.measureText(lines[0]).width), 2);
      }
      y += Math.max(44, lines.length * 27 + 16);
    }
    // Tips
    ctx.fillStyle = CHAT.mainDim;
    ctx.font = `500 19px ${SANS}`;
    const tipY = this.height - 120;
    ctx.fillText('In your terminal:', x0 + 28, tipY);
    ctx.font = `600 19px ${MONO}`;
    ctx.fillStyle = CHAT.codeFg;
    ctx.fillText('task', x0 + 28, tipY + 32);
    ctx.fillText('hint', x0 + 28, tipY + 62);
    ctx.fillStyle = CHAT.mainDim;
    ctx.font = `500 19px ${SANS}`;
    ctx.fillText('show this checklist', x0 + 100, tipY + 32);
    ctx.fillText('when you are stuck', x0 + 100, tipY + 62);
  }

  private wrap(text: string, maxW: number): string[] {
    const ctx = this.ctx;
    const words = text.split(' ');
    const out: string[] = [];
    let line = '';
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (ctx.measureText(t).width > maxW && line) {
        out.push(line);
        line = w;
      } else line = t;
    }
    if (line) out.push(line);
    return out;
  }
}
