/**
 * Turns ANSI-colored text (what the engine emits) into styled spans the canvas
 * renderer can draw, and wraps them to a terminal width.
 */

export interface Style {
  fg: string | null; // palette key or null for default
  bold: boolean;
  dim: boolean;
}

export interface Span {
  text: string;
  style: Style;
}

const BASE: Style = { fg: null, bold: false, dim: false };

const FG: Record<number, string> = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white',
  90: 'gray',
  91: 'brightRed',
  92: 'brightGreen',
  93: 'brightYellow',
  94: 'brightBlue',
  95: 'brightMagenta',
  96: 'brightCyan',
  97: 'brightWhite',
};

export function parseAnsi(line: string): Span[] {
  const spans: Span[] = [];
  let style: Style = { ...BASE };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (text: string) => {
    if (!text) return;
    const prev = spans[spans.length - 1];
    if (prev && prev.style.fg === style.fg && prev.style.bold === style.bold && prev.style.dim === style.dim) prev.text += text;
    else spans.push({ text, style: { ...style } });
  };
  while ((m = re.exec(line))) {
    push(line.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (const code of codes) {
      if (code === 0) style = { ...BASE };
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 22) {
        style.bold = false;
        style.dim = false;
      } else if (code === 39) style.fg = null;
      else if (FG[code]) style.fg = FG[code];
    }
  }
  push(line.slice(last));
  return spans;
}

/** Expand tabs to 8-column stops, like a real terminal. */
export function expandTabs(spans: Span[]): Span[] {
  let col = 0;
  return spans.map((s) => {
    let out = '';
    for (const ch of s.text) {
      if (ch === '\t') {
        const n = 8 - (col % 8);
        out += ' '.repeat(n);
        col += n;
      } else {
        out += ch;
        col++;
      }
    }
    return { ...s, text: out };
  });
}

/** Split a styled line into rows of at most `cols` characters. */
export function wrapSpans(spans: Span[], cols: number): Span[][] {
  const rows: Span[][] = [[]];
  let used = 0;
  for (const s of spans) {
    let text = s.text;
    while (text.length) {
      const room = cols - used;
      if (room <= 0) {
        rows.push([]);
        used = 0;
        continue;
      }
      const chunk = [...text].slice(0, room).join('');
      rows[rows.length - 1].push({ text: chunk, style: s.style });
      used += [...chunk].length;
      text = text.slice(chunk.length);
    }
  }
  return rows;
}

export function spansLength(spans: Span[]): number {
  return spans.reduce((n, s) => n + [...s.text].length, 0);
}
