import { describe, expect, it } from 'vitest';
import { hunkHeader, merge3, myersDiff, splitLines, toHunks } from '../../src/engine/diff';
import { sha1 } from '../../src/engine/sha1';
import { createHash } from 'node:crypto';

describe('sha1', () => {
  it('matches node crypto', () => {
    for (const s of ['', 'abc', 'blob 5\0hello', 'x'.repeat(1000), 'ünïcødé ✓']) {
      expect(sha1(s)).toBe(createHash('sha1').update(s, 'utf8').digest('hex'));
    }
  });
});

describe('myersDiff', () => {
  it('produces a minimal edit script', () => {
    const ops = myersDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
    expect(ops.map((o) => o.op + o.text)).toEqual([' a', '-b', '+x', ' c']);
  });
  it('handles empty inputs', () => {
    expect(myersDiff([], [])).toEqual([]);
    expect(myersDiff([], ['a']).map((o) => o.op)).toEqual(['+']);
    expect(myersDiff(['a'], []).map((o) => o.op)).toEqual(['-']);
  });
  it('builds hunks with git-style headers', () => {
    const a = splitLines('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
    const b = splitLines('1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n10\n');
    const hs = toHunks(myersDiff(a, b));
    expect(hs).toHaveLength(1);
    expect(hunkHeader(hs[0])).toBe('@@ -2,7 +2,7 @@');
  });
  it('uses 0 start for a hunk that adds to an empty file', () => {
    const hs = toHunks(myersDiff([], ['hello']));
    expect(hunkHeader(hs[0])).toBe('@@ -0,0 +1 @@');
  });
});

describe('merge3', () => {
  const base = 'a\nb\nc\nd\ne\n';
  it('takes non-overlapping changes from both sides', () => {
    const r = merge3(base, 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n');
    expect(r.conflicts).toBe(0);
    expect(r.content).toBe('A\nb\nc\nd\nE\n');
  });
  it('marks overlapping edits as conflicts', () => {
    const r = merge3(base, 'a\nb\nOURS\nd\ne\n', 'a\nb\nTHEIRS\nd\ne\n', 'HEAD', 'feature');
    expect(r.conflicts).toBe(1);
    expect(r.content).toBe('a\nb\n<<<<<<< HEAD\nOURS\n=======\nTHEIRS\n>>>>>>> feature\nd\ne\n');
  });
  it('treats identical edits on both sides as clean', () => {
    const r = merge3(base, 'a\nX\nc\nd\ne\n', 'a\nX\nc\nd\ne\n');
    expect(r.conflicts).toBe(0);
  });
  it('handles add/add with an empty base', () => {
    const r = merge3('', 'one\n', 'two\n');
    expect(r.conflicts).toBe(1);
  });
});
