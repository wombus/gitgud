import { stripAnsi } from '../src/engine/ansi';
import { officeTime } from '../src/engine/util';
import { World } from '../src/engine/world';
import { Shell } from '../src/shell/shell';

/** A fresh world with an identity configured, like a real dev machine. */
export function newWorld(opts: { identity?: boolean } = {}): World {
  const w = new World(officeTime('2026-03-02 09:00'));
  if (opts.identity !== false) {
    w.globalConfig.set('user.name', 'Junior Dev');
    w.globalConfig.set('user.email', 'junior@conglomo.com');
  }
  return w;
}

export type EditorScript = (filename: string, content: string) => string | null;

export function newShell(world = newWorld(), editor?: EditorScript): Shell {
  return new Shell(world, async (f, c) => (editor ? editor(f, c) : c));
}

/** Run commands, returning plain-text output of the last one. */
export async function run(sh: Shell, ...lines: string[]): Promise<string> {
  let out = '';
  for (const l of lines) {
    const r = await sh.run(l);
    out = r.lines.map(stripAnsi).join('\n');
  }
  return out;
}

/** Run commands and return a full transcript (for comparisons with real git). */
export async function transcript(sh: Shell, lines: string[]): Promise<string> {
  const parts: string[] = [];
  for (const l of lines) {
    const r = await sh.run(l);
    parts.push(`$ ${l}`, ...r.lines.map(stripAnsi));
  }
  return parts.join('\n');
}
