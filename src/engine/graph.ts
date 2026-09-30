import type { Hash } from './objects';

/**
 * ASCII commit graph, in the style of `git log --graph`.
 *
 * The renderer keeps a list of "lanes" (columns). Each lane is waiting for a
 * particular commit to appear. When a commit is printed:
 *   1. its lane gets a `*`; other lanes get `|`
 *   2. its lane is replaced by its parents (a merge fans out into extra lanes: `|\`)
 *   3. lanes that are now waiting for the same commit collapse together (`|/`)
 * Lanes move at most one column per row, which is why wide collapses produce
 * several rows of `/` - exactly like git does.
 */

const LANE_COLORS = ['31', '32', '33', '34', '35', '36'];

interface Lane {
  hash: Hash;
  color: string;
}

interface Cell {
  ch: string;
  color?: string;
}

function renderCells(cells: Cell[]): string {
  let s = '';
  for (const cell of cells) s += cell.color ? `\x1b[${cell.color}m${cell.ch}\x1b[0m` : cell.ch;
  return s;
}

export interface GraphStep {
  /** The row containing the `*`. */
  commitRow: string;
  /** Rows drawing lanes fanning out or collapsing after this commit. */
  transitions: string[];
  /** Prefix for any further text lines belonging to this commit. */
  continuation: string;
  /** Visible width of the prefixes (for alignment). */
  width: number;
}

export class GraphRenderer {
  private lanes: Lane[] = [];
  private colorIdx = 0;

  constructor(private parentsOf: (h: Hash) => Hash[]) {}

  private newColor(): string {
    const col = LANE_COLORS[this.colorIdx % LANE_COLORS.length];
    this.colorIdx++;
    return col;
  }

  next(h: Hash): GraphStep {
    let col = this.lanes.findIndex((l) => l.hash === h);
    if (col < 0) {
      this.lanes.push({ hash: h, color: this.newColor() });
      col = this.lanes.length - 1;
    }
    const before = this.lanes;

    const commitCells: Cell[] = [];
    before.forEach((l, i) => {
      if (i > 0) commitCells.push({ ch: ' ' });
      commitCells.push(i === col ? { ch: '*' } : { ch: '|', color: l.color });
    });

    const parents = this.parentsOf(h);
    const laneColor = before[col].color;
    const expanded: Lane[] = [
      ...before.slice(0, col),
      ...parents.map((p, i) => ({ hash: p, color: i === 0 ? laneColor : this.newColor() })),
      ...before.slice(col + 1),
    ];

    interface Edge {
      pos: number;
      dst: number;
      color: string;
    }
    const edges: Edge[] = [];
    before.forEach((l, k) => {
      if (k === col) return;
      edges.push({ pos: k, dst: k < col ? k : k + parents.length - 1, color: l.color });
    });
    parents.forEach((_, i) => edges.push({ pos: col, dst: col + i, color: expanded[col + i].color }));

    // Collapse lanes that now wait for the same commit.
    const final: Lane[] = [];
    const map: number[] = [];
    expanded.forEach((l, j) => {
      const existing = final.findIndex((f) => f.hash === l.hash);
      if (existing >= 0) map[j] = existing;
      else {
        map[j] = final.length;
        final.push(l);
      }
    });
    for (const e of edges) e.dst = map[e.dst];

    const maxLanes = Math.max(before.length, expanded.length, 1);
    const width = maxLanes * 2 - 1;

    const transitions: string[] = [];
    let guard = 0;
    while (edges.some((e) => e.pos !== e.dst) && guard++ < 50) {
      const cells: Cell[] = Array.from({ length: width + 1 }, () => ({ ch: ' ' }));
      for (const e of edges) {
        if (e.pos === e.dst) cells[2 * e.pos] = { ch: '|', color: e.color };
        else if (e.dst < e.pos) {
          cells[2 * e.pos - 1] = { ch: '/', color: e.color };
          e.pos--;
        } else {
          cells[2 * e.pos + 1] = { ch: '\\', color: e.color };
          e.pos++;
        }
      }
      transitions.push(renderCells(cells).replace(/ +$/, ''));
    }

    this.lanes = final;
    const contCells: Cell[] = [];
    final.forEach((l, i) => {
      if (i > 0) contCells.push({ ch: ' ' });
      contCells.push({ ch: '|', color: l.color });
    });

    return {
      commitRow: renderCells(commitCells),
      transitions,
      continuation: renderCells(contCells),
      width,
    };
  }
}

export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Zip graph prefixes with the text lines of one commit. */
export function zipGraph(step: GraphStep, text: string[]): string[] {
  const prefixes = [step.commitRow, ...step.transitions];
  const n = Math.max(prefixes.length, text.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = prefixes[i] ?? step.continuation;
    const t = text[i] ?? '';
    const pad = ' '.repeat(Math.max(0, step.width - visibleLength(p)));
    out.push(t ? `${p}${pad} ${t}` : p);
  }
  return out;
}
