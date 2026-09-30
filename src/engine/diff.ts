/**
 * Line-based diffing (Myers' O(ND) algorithm) and three-way merging (diff3).
 *
 * Myers finds the *shortest edit script* between two sequences: the fewest line
 * insertions/deletions that turn A into B. It's the same algorithm git uses by
 * default, which is why our hunks look like git's.
 *
 * diff3 is how git merges a file changed on two branches: compare both sides to
 * their common ancestor ("base"). Regions only one side changed are taken
 * automatically; regions *both* sides changed differently become conflicts.
 */

export type DiffOpKind = ' ' | '-' | '+';

export interface DiffOp {
  op: DiffOpKind;
  text: string;
  /** index into the old sequence (for ' ' and '-') */
  a: number;
  /** index into the new sequence (for ' ' and '+') */
  b: number;
}

export function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function joinLines(lines: string[]): string {
  return lines.length ? lines.join('\n') + '\n' : '';
}

export function myersDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const size = 2 * max + 3;
  let v: Int32Array = new Int32Array(size);
  const trace: Int32Array[] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Walk the trace backwards to recover the edit script.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    v = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: ' ', text: a[x - 1], a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: '+', text: b[y - 1], a: x, b: y - 1 });
      else ops.push({ op: '-', text: a[x - 1], a: x - 1, b: y });
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  return ops;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  ops: DiffOp[];
}

/** Group an edit script into unified-diff hunks with `context` lines around each change. */
export function toHunks(ops: DiffOp[], context = 3): Hunk[] {
  const changeIdx: number[] = [];
  ops.forEach((o, i) => {
    if (o.op !== ' ') changeIdx.push(i);
  });
  if (!changeIdx.length) return [];

  const ranges: Array<[number, number]> = [];
  for (const i of changeIdx) {
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  return ranges.map(([s, e]) => {
    const slice = ops.slice(s, e + 1);
    let oldLines = 0;
    let newLines = 0;
    for (const o of slice) {
      if (o.op !== '+') oldLines++;
      if (o.op !== '-') newLines++;
    }
    // Position of the first line in each file (0-based) at the start of the hunk.
    const first = slice[0];
    const oldPos = first.op === '+' ? first.a : first.a;
    const newPos = first.op === '-' ? first.b : first.b;
    return {
      oldStart: oldLines ? oldPos + 1 : oldPos,
      oldLines,
      newStart: newLines ? newPos + 1 : newPos,
      newLines,
      ops: slice,
    };
  });
}

export function hunkHeader(h: Hunk): string {
  const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);
  return `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`;
}

export function countChanges(oldText: string, newText: string): { ins: number; del: number } {
  const ops = myersDiff(splitLines(oldText), splitLines(newText));
  let ins = 0;
  let del = 0;
  for (const o of ops) {
    if (o.op === '+') ins++;
    else if (o.op === '-') del++;
  }
  return { ins, del };
}

/* ------------------------------------------------------------------------- */
/* Three-way merge                                                            */
/* ------------------------------------------------------------------------- */

type Chunk =
  | { stable: true; lines: string[] }
  | { stable: false; o: string[]; a: string[]; b: string[] };

/** For each line of `o`, the index of the matching line in `x` (or -1). */
function matchIndex(o: string[], x: string[]): Int32Array {
  const m = new Int32Array(o.length).fill(-1);
  for (const op of myersDiff(o, x)) if (op.op === ' ') m[op.a] = op.b;
  return m;
}

function diff3Chunks(o: string[], a: string[], b: string[]): Chunk[] {
  const ma = matchIndex(o, a);
  const mb = matchIndex(o, b);
  const chunks: Chunk[] = [];
  let lo = 0;
  let la = 0;
  let lb = 0;
  for (;;) {
    let i = 0;
    while (lo + i < o.length && ma[lo + i] === la + i && mb[lo + i] === lb + i) i++;
    if (i > 0) {
      chunks.push({ stable: true, lines: o.slice(lo, lo + i) });
      lo += i;
      la += i;
      lb += i;
      continue;
    }
    let j = lo;
    while (j < o.length && !(ma[j] >= 0 && mb[j] >= 0)) j++;
    if (j >= o.length) {
      if (lo < o.length || la < a.length || lb < b.length) {
        chunks.push({ stable: false, o: o.slice(lo), a: a.slice(la), b: b.slice(lb) });
      }
      break;
    }
    chunks.push({ stable: false, o: o.slice(lo, j), a: a.slice(la, ma[j]), b: b.slice(lb, mb[j]) });
    lo = j;
    la = ma[j];
    lb = mb[j];
  }
  return chunks;
}

const sameLines = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);

export interface MergeResult {
  content: string;
  conflicts: number;
}

/**
 * Merge `ours` and `theirs`, both descended from `base`. Conflicting regions are
 * written with the classic markers:
 *
 *   <<<<<<< HEAD
 *   our version
 *   =======
 *   their version
 *   >>>>>>> feature
 */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
  oursLabel = 'HEAD',
  theirsLabel = 'theirs',
): MergeResult {
  const o = splitLines(base);
  const a = splitLines(ours);
  const b = splitLines(theirs);
  const out: string[] = [];
  let conflicts = 0;

  for (const ch of diff3Chunks(o, a, b)) {
    if (ch.stable) {
      out.push(...ch.lines);
      continue;
    }
    if (sameLines(ch.a, ch.o)) out.push(...ch.b);
    else if (sameLines(ch.b, ch.o)) out.push(...ch.a);
    else if (sameLines(ch.a, ch.b)) out.push(...ch.a);
    else {
      // "Zealous" trimming, like git: identical lines at the edges of a conflict
      // aren't really in conflict, so hoist them out of the markers.
      let pre = 0;
      while (pre < ch.a.length && pre < ch.b.length && ch.a[pre] === ch.b[pre]) pre++;
      let suf = 0;
      while (
        suf < ch.a.length - pre &&
        suf < ch.b.length - pre &&
        ch.a[ch.a.length - 1 - suf] === ch.b[ch.b.length - 1 - suf]
      )
        suf++;
      out.push(...ch.a.slice(0, pre));
      out.push(`<<<<<<< ${oursLabel}`);
      out.push(...ch.a.slice(pre, ch.a.length - suf));
      out.push('=======');
      out.push(...ch.b.slice(pre, ch.b.length - suf));
      out.push(`>>>>>>> ${theirsLabel}`);
      out.push(...ch.a.slice(ch.a.length - suf));
      conflicts++;
    }
  }
  return { content: joinLines(out), conflicts };
}

export function hasConflictMarkers(content: string): boolean {
  return /^(<{7}|={7}|>{7})( |$)/m.test(content);
}
