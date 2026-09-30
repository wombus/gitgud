import { filterBySpecs, pathspecs, print, requireRepo, type GitContext } from '../context';
import { diffFileMaps, formatLongStatus, formatPatch, formatStat } from '../format';
import { shortHash, subject, type FileMap, type Hash } from '../objects';
import type { Repository } from '../repo';
import { Args, failure, fatal, GitError } from '../util';
import { applyMergeResult, mergeTrees, touchedPaths } from './merging';

/**
 * git stash, implemented the way git really does it: a stash entry is a commit
 * (W) whose tree is your working directory, with two parents: the commit you were
 * on (B) and a commit holding the state of your index (I). Untracked files, when
 * included with -u, ride along in a third parent (U).
 */

function stashIndex(repo: Repository, arg: string | undefined): number {
  if (!arg) return 0;
  const m = /^(?:stash@\{(\d+)\}|(\d+))$/.exec(arg);
  if (!m) throw fatal(`'${arg}' is not a stash-like commit`);
  const n = parseInt(m[1] ?? m[2], 10);
  if (n >= repo.stash.length) throw failure(`error: stash@{${n}} is not a valid reference`);
  return n;
}

function describeHead(repo: Repository): string {
  const h = repo.headHash()!;
  return `${repo.currentBranch() ?? '(no branch)'}: ${shortHash(h)} ${subject(repo.objects.commit(h).message)}`;
}

function push(ctx: GitContext, repo: Repository, a: Args): number {
  const head = repo.headHash();
  if (!head) throw fatal('You do not have the initial commit yet');
  if (repo.conflicts.size) {
    print(ctx, ...[...repo.conflicts.keys()].map((p) => `${p}: needs merge`));
    throw failure('error: could not write index');
  }
  const includeUntracked = a.has('-u', '--include-untracked', '-a', '--all');
  const keepIndex = a.has('-k', '--keep-index');
  const specArgs = [...(a.afterDashDash ?? []), ...a.rest];
  const specs = specArgs.length ? pathspecs(ctx, repo, specArgs) : null;

  const s = repo.status();
  const untracked = includeUntracked
    ? [...repo.worktree.keys()].filter((p) => !repo.isTracked(p) && !repo.isIgnored(p) && (!specs || filterBySpecs([p], specs).length))
    : [];
  const changed = [...s.staged.map((x) => x.path), ...s.staged.filter((x) => x.from).map((x) => x.from!), ...s.unstaged.map((x) => x.path)].filter(
    (p) => !specs || filterBySpecs([p], specs).length,
  );
  if (!changed.length && !untracked.length) {
    print(ctx, 'No local changes to save');
    return 0;
  }

  const headFiles = repo.commitFiles(head);
  const desc = describeHead(repo);
  const msg = a.value('-m', '--message');

  // I: the index. With pathspecs, only those paths' staged state is stashed.
  const indexFiles: FileMap = new Map(headFiles);
  for (const p of new Set([...headFiles.keys(), ...repo.index.keys()])) {
    if (specs && !filterBySpecs([p], specs).length) continue;
    const h = repo.index.get(p);
    if (h === undefined) indexFiles.delete(p);
    else indexFiles.set(p, h);
  }
  const I = repo.makeCommit(repo.writeTree(indexFiles), [head], `index on ${desc}`);

  // W: the working tree (tracked files).
  const wtFiles: FileMap = new Map(indexFiles);
  for (const p of new Set([...indexFiles.keys()])) {
    if (specs && !filterBySpecs([p], specs).length) continue;
    const content = repo.worktree.get(p);
    if (content === undefined) wtFiles.delete(p);
    else wtFiles.set(p, repo.objects.putBlob(content));
  }
  const parents = [head, I];
  if (untracked.length) {
    const uFiles: FileMap = new Map(untracked.map((p) => [p, repo.objects.putBlob(repo.worktree.get(p)!)]));
    parents.push(repo.makeCommit(repo.writeTree(uFiles), [], `untracked files on ${desc}`));
  }
  const title = msg ? `On ${repo.currentBranch() ?? '(no branch)'}: ${msg}` : `WIP on ${desc}`;
  const W = repo.makeCommit(repo.writeTree(wtFiles), parents, title);
  // repo.stash plays the role of git's refs/stash reflog: dropping an entry really forgets it.
  repo.stash.unshift(W);

  // Clean up: put stashed paths back to HEAD (keeping the index if asked).
  for (const p of new Set([...headFiles.keys(), ...repo.index.keys(), ...wtFiles.keys()])) {
    if (specs && !filterBySpecs([p], specs).length) continue;
    if (keepIndex) {
      const ih = repo.index.get(p);
      if (ih === undefined) repo.worktree.delete(p);
      else repo.worktree.set(p, repo.blob(ih));
    } else {
      repo.writePath(p, headFiles.get(p));
    }
  }
  for (const p of untracked) repo.worktree.delete(p);

  print(ctx, `Saved working directory and index state ${title}`);
  ctx.world.emit({ type: 'stash', action: 'push', hash: W });
  return 0;
}

function apply(ctx: GitContext, repo: Repository, n: number, restoreIndex: boolean, verb: 'apply' | 'pop'): boolean {
  const W = repo.stash[n];
  const co = repo.objects.commit(W);
  const [B, I, U] = co.parents;
  const head = repo.headHash();
  if (!head) throw fatal('You do not have the initial commit yet');
  if (repo.conflicts.size) throw failure('error: could not apply stash: you have unmerged paths\nThe stash entry is kept in case you need it again.');

  const baseFiles = repo.commitFiles(B);
  const stashFiles = repo.commitFiles(W);
  // "ours" is the current index, as a tree.
  const ours: FileMap = new Map(repo.index);
  const r = mergeTrees(repo, baseFiles, ours, stashFiles, 'Updated upstream', 'Stashed changes');

  const dirty = touchedPaths(ours, r).filter((p) => repo.worktree.has(p) && repo.worktreeHash(p) !== repo.index.get(p));
  if (dirty.length) {
    throw failure(
      'error: Your local changes to the following files would be overwritten by merge:\n' +
        dirty.map((p) => `\t${p}`).join('\n') +
        '\nPlease commit your changes or stash them before you merge.\nAborting\nThe stash entry is kept in case you need it again.',
    );
  }
  if (U) {
    const uFiles = repo.commitFiles(U);
    const exists = [...uFiles.keys()].filter((p) => repo.worktree.has(p));
    if (exists.length) {
      throw failure(`${exists.map((p) => `${p} already exists, no checkout`).join('\n')}\nerror: could not restore untracked files from stash`);
    }
  }

  const indexBefore = new Map(repo.index);
  applyMergeResult(repo, ours, r);
  if (!restoreIndex) {
    // Without --index, changes come back unstaged... except brand-new files, which
    // stay added so they don't turn invisible.
    for (const p of touchedPaths(ours, r)) {
      if (r.conflicts.has(p)) continue;
      const wasNew = !baseFiles.has(p) && stashFiles.has(p);
      if (wasNew) continue;
      const prev = indexBefore.get(p);
      if (prev === undefined) repo.index.delete(p);
      else repo.index.set(p, prev);
    }
  } else if (I) {
    for (const [p, h] of repo.commitFiles(I)) if (!r.conflicts.has(p)) repo.index.set(p, h);
  }
  if (U) for (const [p, h] of repo.commitFiles(U)) repo.worktree.set(p, repo.blob(h));

  if (r.conflicts.size) {
    print(ctx, ...r.messages.filter((m) => m.includes('CONFLICT') || m.startsWith('Auto-merging')));
    print(ctx, 'On branch ' + (repo.currentBranch() ?? 'HEAD'));
    print(ctx, 'The stash entry is kept in case you need it again.');
    ctx.world.emit({ type: 'stash', action: verb, conflict: true });
    return false;
  }
  print(ctx, ...formatLongStatus(repo));
  ctx.world.emit({ type: 'stash', action: verb, hash: W });
  return true;
}

export function cmdStash(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const known = ['push', 'save', 'list', 'show', 'pop', 'apply', 'drop', 'clear', 'branch'];
  let sub = 'push';
  let args = argv;
  if (argv.length && known.includes(argv[0])) {
    sub = argv[0];
    args = argv.slice(1);
  } else if (argv.length && !argv[0].startsWith('-')) {
    throw fatal(`subcommand wasn't specified; 'push' can't be assumed due to unexpected token '${argv[0]}'`);
  }
  const a = new Args(args, ['-m', '--message']);

  switch (sub) {
    case 'push':
      return push(ctx, repo, a);
    case 'save': {
      const msg = a.rest.join(' ');
      const b = new Args(msg ? ['-m', msg, ...args.filter((x) => x.startsWith('-'))] : args, ['-m']);
      return push(ctx, repo, b);
    }
    case 'list':
      repo.stash.forEach((h, i) => print(ctx, `stash@{${i}}: ${repo.objects.commit(h).message}`));
      return 0;
    case 'show': {
      if (!repo.stash.length) throw failure('No stash entries found.');
      const n = stashIndex(repo, a.rest[0]);
      const W = repo.stash[n];
      const diffs = diffFileMaps(repo.commitFiles(repo.parents(W)[0]), repo.commitFiles(W));
      print(ctx, ...(a.has('-p', '--patch') ? formatPatch(repo, diffs) : formatStat(repo, diffs)));
      return 0;
    }
    case 'apply':
    case 'pop': {
      if (!repo.stash.length) throw failure('No stash entries found.');
      const n = stashIndex(repo, a.rest[0]);
      const ok = apply(ctx, repo, n, a.has('--index'), sub);
      if (!ok) return 1;
      if (sub === 'pop') {
        const h = repo.stash.splice(n, 1)[0];
        print(ctx, `Dropped ${a.rest[0] ?? 'refs/stash@{0}'} (${h})`);
      }
      return 0;
    }
    case 'drop': {
      if (!repo.stash.length) throw failure('No stash entries found.');
      const n = stashIndex(repo, a.rest[0]);
      const h = repo.stash.splice(n, 1)[0];
      print(ctx, `Dropped stash@{${n}} (${h})`);
      ctx.world.emit({ type: 'stash', action: 'drop', hash: h });
      return 0;
    }
    case 'clear':
      ctx.world.emit({ type: 'stash', action: 'clear', count: repo.stash.length });
      repo.stash = [];
      return 0;
    case 'branch': {
      const name = a.rest[0];
      if (!name) throw fatal('No branch name specified');
      if (!repo.stash.length) throw failure('No stash entries found.');
      const n = stashIndex(repo, a.rest[1]);
      const W = repo.stash[n];
      const B = repo.parents(W)[0];
      if (repo.branchHash(name)) throw fatal(`a branch named '${name}' already exists`);
      if (!repo.isClean()) throw new GitError('error: Your local changes would be overwritten.\nPlease commit or stash them.', 1);
      repo.setRef(`refs/heads/${name}`, B, `branch: Created from ${shortHash(B)}`);
      repo.resetTo(repo.commitFiles(B), { worktree: true });
      repo.attachHead(name, `checkout: moving from ${repo.currentBranch() ?? repo.headHash()} to ${name}`);
      print(ctx, `Switched to a new branch '${name}'`);
      if (apply(ctx, repo, n, true, 'pop')) {
        const h = repo.stash.splice(n, 1)[0];
        print(ctx, `Dropped stash@{${n}} (${h})`);
      }
      return 0;
    }
  }
  return 0;
}

export type { Hash };
