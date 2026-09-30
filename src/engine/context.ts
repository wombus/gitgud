import type { Repository } from './repo';
import { fatal, GitError, matchPathspec, resolveRepoPath } from './util';
import type { World } from './world';

/** Opens a (fake) text editor; resolves with the saved text, or null if cancelled. */
export type EditorFn = (filename: string, content: string) => Promise<string | null>;

export interface GitContext {
  world: World;
  /** The project directory the shell is in (initialized or not), or null when in ~. */
  dir: Repository | null;
  /** Current directory inside `dir` ('' = its root). */
  cwd: string;
  editor: EditorFn;
  /** Output lines (may contain ANSI color codes). */
  out: string[];
}

export type Command = (ctx: GitContext, args: string[]) => Promise<number | void> | number | void;

export function requireRepo(ctx: GitContext): Repository {
  if (!ctx.dir || !ctx.dir.initialized) {
    throw fatal('not a git repository (or any of the parent directories): .git');
  }
  return ctx.dir;
}

export function repoRoot(ctx: GitContext, repo: Repository): string {
  return `${ctx.world.homePath}/${repo.name}`;
}

/** Convert a user-typed path (relative to the shell's cwd) into a repo path. */
export function toRepoPath(ctx: GitContext, repo: Repository, arg: string): string {
  const p = resolveRepoPath(ctx.cwd, arg);
  if (p === null) throw fatal(`${arg}: '${arg}' is outside repository at '${repoRoot(ctx, repo)}'`);
  return p;
}

/** Resolve pathspecs; '.' in the repo root becomes '' (match everything). */
export function pathspecs(ctx: GitContext, repo: Repository, args: string[]): string[] {
  return args.map((a) => toRepoPath(ctx, repo, a));
}

export function filterBySpecs(paths: Iterable<string>, specs: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) if (specs.some((s) => matchPathspec(s, p))) out.push(p);
  return out.sort();
}

export function print(ctx: GitContext, ...lines: string[]): void {
  for (const l of lines) ctx.out.push(...l.split('\n'));
}

export function ensureIdentity(ctx: GitContext, repo: Repository): void {
  if (repo.identity()) return;
  throw new GitError(
    [
      'Author identity unknown',
      '',
      '*** Please tell me who you are.',
      '',
      'Run',
      '',
      '  git config --global user.email "you@example.com"',
      '  git config --global user.name "Your Name"',
      '',
      "to set your account's default identity.",
      'Omit --global to set the identity only in this repository.',
      '',
      `fatal: unable to auto-detect email address (got '${ctx.world.user}@${ctx.world.host}.(none)')`,
    ].join('\n'),
    128,
  );
}
