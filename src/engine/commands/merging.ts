import { c } from '../ansi';
import { ensureIdentity, print, requireRepo, type GitContext } from '../context';
import { hasConflictMarkers, merge3 } from '../diff';
import { cleanMessage, commitSummary, diffFileMaps, mergeSummary } from '../format';
import { shortHash, subject, type FileMap, type Hash } from '../objects';
import type { ConflictEntry, RebaseAction, RebaseStep, Repository } from '../repo';
import { dwimRef, revParseCommit, tryRevParse } from '../revparse';
import { Args, failure, fatal, GitError, plural } from '../util';
import { walk } from './history';
import { cmdCommit, recordCommit } from './basic';
import { cmdCheckout } from './branching';

/* ------------------------------------------------------------------------- */
/* Three-way tree merge (the "ort" strategy, minus the heroics)               */
/* ------------------------------------------------------------------------- */

export interface TreeMergeResult {
  /** Cleanly merged entries (stage 0). */
  files: FileMap;
  conflicts: Map<string, ConflictEntry>;
  /** Worktree contents for conflicted paths (with markers); undefined = file absent. */
  conflictContent: Map<string, string | undefined>;
  messages: string[];
}

export function mergeTrees(
  repo: Repository,
  base: FileMap,
  ours: FileMap,
  theirs: FileMap,
  oursLabel: string,
  theirsLabel: string,
): TreeMergeResult {
  const files: FileMap = new Map();
  const conflicts = new Map<string, ConflictEntry>();
  const conflictContent = new Map<string, string | undefined>();
  const messages: string[] = [];
  const paths = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort();

  for (const p of paths) {
    const b = base.get(p);
    const o = ours.get(p);
    const t = theirs.get(p);
    if (o === t) {
      if (o !== undefined) files.set(p, o);
      continue;
    }
    if (o === b) {
      if (t !== undefined) files.set(p, t);
      continue;
    }
    if (t === b) {
      if (o !== undefined) files.set(p, o);
      continue;
    }
    // Both sides changed this path, differently.
    if (o !== undefined && t !== undefined) {
      messages.push(`Auto-merging ${p}`);
      const r = merge3(b ? repo.blob(b) : '', repo.blob(o), repo.blob(t), oursLabel, theirsLabel);
      if (r.conflicts === 0) {
        files.set(p, repo.objects.putBlob(r.content));
      } else {
        messages.push(c.red(`CONFLICT (${b ? 'content' : 'add/add'}): Merge conflict in ${p}`));
        conflicts.set(p, { base: b, ours: o, theirs: t });
        conflictContent.set(p, r.content);
      }
    } else if (o !== undefined) {
      messages.push(
        c.red(`CONFLICT (modify/delete): ${p} deleted in ${theirsLabel} and modified in ${oursLabel}.`) +
          `  Version ${oursLabel} of ${p} left in tree.`,
      );
      conflicts.set(p, { base: b, ours: o });
      conflictContent.set(p, repo.blob(o));
    } else {
      messages.push(
        c.red(`CONFLICT (modify/delete): ${p} deleted in ${oursLabel} and modified in ${theirsLabel}.`) +
          `  Version ${theirsLabel} of ${p} left in tree.`,
      );
      conflicts.set(p, { base: b, theirs: t });
      conflictContent.set(p, repo.blob(t!));
    }
  }
  return { files, conflicts, conflictContent, messages };
}

/** Paths whose content the merge result changes relative to `ours`. */
export function touchedPaths(ours: FileMap, r: TreeMergeResult): string[] {
  const out = new Set<string>(r.conflicts.keys());
  for (const p of new Set([...ours.keys(), ...r.files.keys()])) {
    if (r.conflicts.has(p)) continue;
    if (ours.get(p) !== r.files.get(p)) out.add(p);
  }
  return [...out].sort();
}

/** Would applying this result clobber uncommitted work? Returns offending paths. */
export function mergeBlockers(repo: Repository, ours: FileMap, r: TreeMergeResult): { dirty: string[]; untracked: string[] } {
  const dirty: string[] = [];
  const untracked: string[] = [];
  for (const p of touchedPaths(ours, r)) {
    const tracked = repo.isTracked(p) || ours.has(p);
    if (!tracked) {
      if (repo.worktree.has(p)) untracked.push(p);
      continue;
    }
    const i = repo.index.get(p);
    if (i !== ours.get(p) || repo.worktreeHash(p) !== i) dirty.push(p);
  }
  return { dirty, untracked };
}

export function applyMergeResult(repo: Repository, ours: FileMap, r: TreeMergeResult): void {
  for (const p of touchedPaths(ours, r)) {
    if (r.conflicts.has(p)) {
      repo.index.delete(p);
      repo.conflicts.set(p, r.conflicts.get(p)!);
      const content = r.conflictContent.get(p);
      if (content === undefined) repo.worktree.delete(p);
      else repo.worktree.set(p, content);
    } else {
      repo.writePath(p, r.files.get(p));
    }
  }
}

function assertNoOperation(repo: Repository, verb: string): void {
  const op = repo.op;
  if (!op) return;
  if (op.kind === 'merge') {
    if (repo.conflicts.size) {
      throw new GitError(
        `error: ${verb} is not possible because you have unmerged files.\n` +
          "hint: Fix them up in the work tree, and then use 'git add/rm <file>'\n" +
          'hint: as appropriate to mark resolution and make a commit.\n' +
          'fatal: Exiting because of an unresolved conflict.',
        128,
      );
    }
    throw fatal('You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge.');
  }
  if (op.kind === 'rebase') {
    throw fatal(`It seems that you are in the middle of a rebase.\nFinish it with "git rebase --continue" or bail out with "git rebase --abort".`);
  }
  throw fatal(`You have not concluded your ${op.kind}.\nFinish it with "git ${op.kind} --continue" or "git ${op.kind} --abort".`);
}

/* ------------------------------------------------------------------------- */
/* git merge                                                                  */
/* ------------------------------------------------------------------------- */

function defaultMergeMessage(repo: Repository, spec: string, target: Hash): string {
  const ref = dwimRef(repo, spec);
  const into = repo.currentBranch();
  const suffix = into && into !== 'main' && into !== 'master' ? ` into ${into}` : '';
  if (ref?.startsWith('refs/heads/')) return `Merge branch '${ref.slice(11)}'${suffix}`;
  if (ref?.startsWith('refs/remotes/')) return `Merge remote-tracking branch '${ref.slice(13)}'${suffix}`;
  if (ref?.startsWith('refs/tags/')) return `Merge tag '${ref.slice(10)}'${suffix}`;
  return `Merge commit '${shortHash(target)}'${suffix}`;
}

export interface MergeOptions {
  noFF?: boolean;
  ffOnly?: boolean;
  squash?: boolean;
  noCommit?: boolean;
  message?: string;
  /** Reflog verb, e.g. "pull" for merges done by `git pull`. */
  reflogVerb?: string;
}

/** Merge `target` into HEAD. Returns the exit code. Shared by `git merge` and `git pull`. */
export function doMerge(ctx: GitContext, repo: Repository, spec: string, target: Hash, o: MergeOptions = {}): number {
  const head = repo.headHash();
  const verb = o.reflogVerb ?? `merge ${spec}`;

  if (!head) {
    // Merging into an unborn branch just points it at the target.
    repo.resetTo(repo.commitFiles(target), { worktree: true });
    repo.moveHead(target, `${verb}: Fast-forward`);
    return 0;
  }
  if (repo.isAncestor(target, head)) {
    print(ctx, 'Already up to date.');
    return 0;
  }
  const headFiles = repo.commitFiles(head);
  const canFF = repo.isAncestor(head, target);

  if (canFF && !o.noFF && !o.squash) {
    const targetFiles = repo.commitFiles(target);
    const { dirty, untracked } = repo.switchBlockers(targetFiles);
    if (dirty.length || untracked.length) {
      const list = dirty.length ? dirty : untracked;
      throw failure(
        `Updating ${shortHash(head)}..${shortHash(target)}\n` +
          `error: ${dirty.length ? 'Your local changes to the following files' : 'The following untracked working tree files'} would be overwritten by merge:\n` +
          list.map((p) => `\t${p}`).join('\n') +
          `\nPlease ${dirty.length ? 'commit your changes or stash them' : 'move or remove them'} before you merge.\nAborting`,
      );
    }
    repo.special.set('ORIG_HEAD', head);
    repo.switchTo(targetFiles);
    repo.moveHead(target, `${verb}: Fast-forward`);
    print(ctx, `Updating ${shortHash(head)}..${shortHash(target)}`, 'Fast-forward', ...mergeSummary(repo, diffFileMaps(headFiles, targetFiles)));
    ctx.world.emit({ type: 'merge', kind: 'ff', target, branch: repo.currentBranch() });
    return 0;
  }
  if (o.ffOnly) throw fatal('Not possible to fast-forward, aborting.');

  const base = repo.mergeBase(head, target);
  if (!base) throw fatal('refusing to merge unrelated histories');

  const r = mergeTrees(repo, repo.commitFiles(base), headFiles, repo.commitFiles(target), 'HEAD', spec);
  const { dirty, untracked } = mergeBlockers(repo, headFiles, r);
  if (dirty.length) {
    throw failure(
      'error: Your local changes to the following files would be overwritten by merge:\n' +
        dirty.map((p) => `\t${p}`).join('\n') +
        '\nPlease commit your changes or stash them before you merge.\nAborting',
    );
  }
  if (untracked.length) {
    throw failure(
      'error: The following untracked working tree files would be overwritten by merge:\n' +
        untracked.map((p) => `\t${p}`).join('\n') +
        '\nPlease move or remove them before you merge.\nAborting',
    );
  }

  repo.special.set('ORIG_HEAD', head);
  applyMergeResult(repo, headFiles, r);
  print(ctx, ...r.messages);
  const message = o.message ?? defaultMergeMessage(repo, spec, target);
  const touched = touchedPaths(headFiles, r);

  if (r.conflicts.size) {
    repo.op = { kind: 'merge', mergeHead: target, message, squash: o.squash, touched };
    if (!o.squash) repo.special.set('MERGE_HEAD', target);
    print(ctx, 'Automatic merge failed; fix conflicts and then commit the result.');
    ctx.world.emit({ type: 'merge', kind: 'conflict', target, paths: [...r.conflicts.keys()] });
    return 1;
  }
  if (o.squash) {
    print(ctx, 'Squash commit -- not updating HEAD', 'Automatic merge went well; stopped before committing as requested');
    ctx.world.emit({ type: 'merge', kind: 'squash', target });
    return 0;
  }
  if (o.noCommit) {
    repo.op = { kind: 'merge', mergeHead: target, message, touched };
    repo.special.set('MERGE_HEAD', target);
    print(ctx, 'Automatic merge went well; stopped before committing as requested');
    return 0;
  }
  ensureIdentity(ctx, repo);
  const h = recordCommit(ctx, repo, [head, target], message, { reflogVerb: verb, quiet: true });
  print(ctx, "Merge made by the 'ort' strategy.", ...mergeSummary(repo, diffFileMaps(headFiles, repo.commitFiles(h))));
  ctx.world.emit({ type: 'merge', kind: 'true', target, commit: h, branch: repo.currentBranch() });
  return 0;
}

export async function cmdMerge(ctx: GitContext, argv: string[]): Promise<number> {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['-m', '--message', '-s', '--strategy', '-X', '--strategy-option']);

  if (a.has('--abort')) {
    const op = repo.op;
    if (op?.kind !== 'merge') throw fatal('There is no merge to abort (MERGE_HEAD missing).');
    const headFiles = repo.headFiles();
    for (const p of op.touched) repo.writePath(p, headFiles.get(p));
    repo.op = null;
    repo.special.delete('MERGE_HEAD');
    ctx.world.emit({ type: 'merge-abort' });
    return 0;
  }
  if (a.has('--continue')) {
    if (repo.op?.kind !== 'merge') throw fatal('There is no merge in progress (MERGE_HEAD missing).');
    return cmdCommit(ctx, []);
  }
  if (a.has('--quit')) {
    repo.op = null;
    repo.special.delete('MERGE_HEAD');
    return 0;
  }

  assertNoOperation(repo, 'Merging');
  if (!a.rest.length) {
    const b = repo.currentBranch();
    const up = b ? repo.upstreamOf(b) : null;
    if (!up) throw fatal('No remote for the current branch.');
    a.rest.push(`${up.remote}/${up.branch}`);
  }
  if (a.rest.length > 1) throw fatal('octopus merges are above your pay grade. Merge one branch at a time.');
  const spec = a.rest[0];
  const target = tryRevParse(repo, spec);
  if (!target) throw new GitError(`merge: ${spec} - not something we can merge`, 1);
  const msgs = a.values('-m', '--message');
  return doMerge(ctx, repo, spec, target, {
    noFF: a.has('--no-ff'),
    ffOnly: a.has('--ff-only'),
    squash: a.has('--squash'),
    noCommit: a.has('--no-commit'),
    message: msgs.length ? msgs.join('\n\n') : undefined,
  });
}

/* ------------------------------------------------------------------------- */
/* git cherry-pick / git revert                                               */
/* ------------------------------------------------------------------------- */

type SeqKind = 'cherry-pick' | 'revert';

interface SeqOptions {
  mainline?: number;
  recordOrigin?: boolean;
  noCommit?: boolean;
}

function expandCommitList(repo: Repository, specs: string[]): Hash[] {
  const out: Hash[] = [];
  for (const s of specs) {
    const range = /^(.*)\.\.(.*)$/.exec(s);
    if (range) {
      const list = walk(repo, {
        include: [revParseCommit(repo, range[2] || 'HEAD')],
        exclude: [revParseCommit(repo, range[1] || 'HEAD')],
      })
        .filter((h) => repo.parents(h).length <= 1)
        .reverse();
      out.push(...list);
    } else {
      out.push(revParseCommit(repo, s));
    }
  }
  return out;
}

function conflictHints(kind: SeqKind, h: Hash, subj: string): string[] {
  const verb = kind === 'cherry-pick' ? 'apply' : 'revert';
  return [
    `error: could not ${verb} ${shortHash(h)}... ${subj}`,
    'hint: After resolving the conflicts, mark them with',
    'hint: "git add/rm <pathspec>", then run',
    `hint: "git ${kind} --continue".`,
    `hint: You can instead skip this commit with "git ${kind} --skip".`,
    `hint: To abort and get back to the state before "git ${kind}",`,
    `hint: run "git ${kind} --abort".`,
  ];
}

/** Apply one commit (or its inverse). Returns false if it stopped on a conflict. */
function applyOne(ctx: GitContext, repo: Repository, kind: SeqKind, h: Hash, todo: Hash[], origHead: Hash, o: SeqOptions): boolean {
  const co = repo.objects.commit(h);
  const subj = subject(co.message);
  if (co.parents.length > 1 && !o.mainline) {
    throw new GitError(`error: commit ${h} is a merge but no -m option was given.\nfatal: ${kind === 'cherry-pick' ? 'cherry-pick' : 'revert'} failed`, 128);
  }
  const parent = co.parents[(o.mainline ?? 1) - 1];
  const parentFiles = parent ? repo.commitFiles(parent) : new Map();
  const commitFiles = repo.commitFiles(h);
  const head = repo.headHash()!;
  const headFiles = repo.commitFiles(head);

  let base: FileMap;
  let theirs: FileMap;
  let label: string;
  let message: string;
  if (kind === 'cherry-pick') {
    base = parentFiles;
    theirs = commitFiles;
    label = `${shortHash(h)} (${subj})`;
    message = co.message.replace(/\n+$/, '');
    if (o.recordOrigin) message += `\n\n(cherry picked from commit ${h})`;
  } else {
    base = commitFiles;
    theirs = parentFiles;
    label = `parent of ${shortHash(h)} (${subj})`;
    message = `Revert "${subj}"\n\nThis reverts commit ${h}`;
    message += co.parents.length > 1 ? `, reversing\nchanges made to ${parent}.` : '.';
  }

  const r = mergeTrees(repo, base, headFiles, theirs, 'HEAD', label);
  const { dirty, untracked } = mergeBlockers(repo, headFiles, r);
  if (dirty.length || untracked.length) {
    throw new GitError(
      `error: your local changes would be overwritten by ${kind}.\nhint: commit your changes or stash them to proceed.\nfatal: ${kind} failed`,
      128,
    );
  }
  applyMergeResult(repo, headFiles, r);

  if (r.conflicts.size) {
    print(ctx, ...r.messages, ...conflictHints(kind, h, subj));
    repo.op = { kind, current: h, todo, message, author: kind === 'cherry-pick' ? co.author : undefined, mainline: o.mainline, recordOrigin: o.recordOrigin, origHead };
    repo.special.set(kind === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD', h);
    ctx.world.emit({ type: kind, stage: 'conflict', commit: h });
    return false;
  }
  if (r.messages.length) print(ctx, ...r.messages);
  if (o.noCommit) return true;

  const newTree = repo.writeTree(repo.index);
  if (newTree === repo.objects.commit(head).tree) {
    // Nothing changed: the commit is already applied (or empty).
    repo.op = { kind, current: h, todo, message, author: kind === 'cherry-pick' ? co.author : undefined, origHead };
    print(
      ctx,
      `On branch ${repo.currentBranch() ?? 'HEAD'}`,
      `You are currently ${kind === 'cherry-pick' ? 'cherry-picking' : 'reverting'} commit ${shortHash(h)}.`,
      '',
      'nothing to commit, working tree clean',
      `The previous ${kind} is now empty, possibly due to conflict resolution.`,
      'If you wish to commit it anyway, use:',
      '',
      '    git commit --allow-empty',
      '',
      `Otherwise, please use 'git ${kind} --skip'`,
    );
    return false;
  }
  ensureIdentity(ctx, repo);
  const author = kind === 'cherry-pick' ? co.author : undefined;
  const nh = recordCommit(ctx, repo, [head], message, { author, reflogVerb: kind === 'cherry-pick' ? 'cherry-pick' : 'revert', showDate: true });
  ctx.world.emit({ type: kind, stage: 'done', commit: h, result: nh, branch: repo.currentBranch() });
  return true;
}

function runSequence(ctx: GitContext, repo: Repository, kind: SeqKind, list: Hash[], origHead: Hash, o: SeqOptions): number {
  const queue = [...list];
  while (queue.length) {
    const h = queue.shift()!;
    if (!applyOne(ctx, repo, kind, h, queue, origHead, o)) return 1;
  }
  repo.op = null;
  repo.special.delete('CHERRY_PICK_HEAD');
  repo.special.delete('REVERT_HEAD');
  return 0;
}

async function sequencerCommand(ctx: GitContext, argv: string[], kind: SeqKind): Promise<number> {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['-m', '--mainline']);
  const op = repo.op;
  const ours = op && op.kind === kind ? op : null;

  if (a.has('--abort')) {
    if (!ours) throw fatal(`no ${kind} in progress`);
    repo.resetTo(repo.commitFiles(ours.origHead), { worktree: true });
    repo.moveHead(ours.origHead, `${kind}: abort`);
    repo.op = null;
    repo.special.delete('CHERRY_PICK_HEAD');
    repo.special.delete('REVERT_HEAD');
    ctx.world.emit({ type: `${kind}-abort` });
    return 0;
  }
  if (a.has('--quit')) {
    repo.op = null;
    return 0;
  }
  if (a.has('--skip')) {
    if (!ours) throw fatal(`no ${kind} in progress`);
    repo.resetTo(repo.headFiles(), { worktree: true });
    return runSequence(ctx, repo, kind, ours.todo, ours.origHead, { mainline: ours.mainline, recordOrigin: ours.recordOrigin });
  }
  if (a.has('--continue')) {
    if (!ours) throw fatal(`no ${kind} in progress`);
    if (repo.conflicts.size) {
      throw new GitError(
        `error: Committing is not possible because you have unmerged files.\n` +
          "hint: Fix them up in the work tree, and then use 'git add/rm <file>'\n" +
          'hint: as appropriate to mark resolution and make a commit.\n' +
          'fatal: Exiting because of an unresolved conflict.\n' +
          `U\t${[...repo.conflicts.keys()].join('\nU\t')}\nerror: could not commit resolved changes`,
        128,
      );
    }
    if (!ours.committed) {
      ensureIdentity(ctx, repo);
      const head = repo.headHash()!;
      if (repo.writeTree(repo.index) === repo.objects.commit(head).tree) {
        print(ctx, `The previous ${kind} is now empty, possibly due to conflict resolution.`, `Otherwise, please use 'git ${kind} --skip'`);
        return 1;
      }
      recordCommit(ctx, repo, [head], ours.message, { author: ours.author, reflogVerb: kind, showDate: true });
      ctx.world.emit({ type: kind, stage: 'done', commit: ours.current, result: repo.headHash(), branch: repo.currentBranch() });
    }
    repo.special.delete('CHERRY_PICK_HEAD');
    repo.special.delete('REVERT_HEAD');
    return runSequence(ctx, repo, kind, ours.todo, ours.origHead, { mainline: ours.mainline, recordOrigin: ours.recordOrigin });
  }

  if (repo.op) assertNoOperation(repo, kind === 'cherry-pick' ? 'Cherry-picking' : 'Reverting');
  if (!a.rest.length) throw fatal(`empty commit set passed\nusage: git ${kind} [<options>] <commit-ish>...`);
  const head = repo.headHash();
  if (!head) throw fatal(`your current branch '${repo.currentBranch()}' does not have any commits yet`);
  const list = expandCommitList(repo, a.rest);
  if (!list.length) throw fatal('empty commit set passed');
  const mainline = a.value('-m', '--mainline');
  const o: SeqOptions = { mainline: mainline ? parseInt(mainline, 10) : undefined, recordOrigin: a.has('-x'), noCommit: a.has('-n', '--no-commit') };
  const code = runSequence(ctx, repo, kind, list, head, o);
  return code;
}

export function cmdCherryPick(ctx: GitContext, argv: string[]): Promise<number> {
  return sequencerCommand(ctx, argv, 'cherry-pick');
}

export function cmdRevert(ctx: GitContext, argv: string[]): Promise<number> {
  return sequencerCommand(ctx, argv, 'revert');
}

/* ------------------------------------------------------------------------- */
/* git rebase                                                                 */
/* ------------------------------------------------------------------------- */

const TODO_HELP = `
# Commands:
# p, pick <commit> = use commit
# r, reword <commit> = use commit, but edit the commit message
# e, edit <commit> = use commit, but stop for amending
# s, squash <commit> = use commit, but meld into previous commit
# f, fixup <commit> = like "squash" but keep only the previous
#                    commit's log message
# d, drop <commit> = remove commit
#
# These lines can be re-ordered; they are executed from top to bottom.
#
# If you remove a line here THAT COMMIT WILL BE LOST.
#
# However, if you remove everything, the rebase will be aborted.
#`;

const ACTIONS: Record<string, RebaseAction> = {
  p: 'pick',
  pick: 'pick',
  r: 'reword',
  reword: 'reword',
  e: 'edit',
  edit: 'edit',
  s: 'squash',
  squash: 'squash',
  f: 'fixup',
  fixup: 'fixup',
  d: 'drop',
  drop: 'drop',
};

export function parseTodo(repo: Repository, text: string): RebaseStep[] {
  const steps: RebaseStep[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [cmd, hash] = line.split(/\s+/);
    const action = ACTIONS[cmd?.toLowerCase()];
    if (!action || !hash) throw failure(`error: invalid line ${i + 1}: ${line}\nYou can fix this with 'git rebase --edit-todo' and then run 'git rebase --continue'.\nOr you can abort the rebase with 'git rebase --abort'.`);
    let commit: Hash;
    try {
      commit = revParseCommit(repo, hash);
    } catch {
      throw failure(`error: invalid line ${i + 1}: ${line}`);
    }
    if ((action === 'squash' || action === 'fixup') && !steps.some((s) => s.action !== 'drop')) {
      throw failure(`error: cannot '${action}' without a previous commit`);
    }
    steps.push({ action, commit });
  });
  return steps;
}

function patchId(repo: Repository, h: Hash): string {
  const ps = repo.parents(h);
  const from = ps.length ? repo.commitFiles(ps[0]) : new Map<string, Hash>();
  const to = repo.commitFiles(h);
  return diffFileMaps(from, to, { renames: false })
    .map((d) => `${d.path}:${d.oldHash ?? '-'}:${d.newHash ?? '-'}`)
    .join('|');
}

function rebaseConflictHints(h: Hash, subj: string): string[] {
  return [
    `error: could not apply ${shortHash(h)}... ${subj}`,
    'hint: Resolve all conflicts manually, mark them as resolved with',
    'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".',
    'hint: You can instead skip this commit: run "git rebase --skip".',
    'hint: To abort and get back to the state before "git rebase", run "git rebase --abort".',
    `Could not apply ${shortHash(h)}... ${subj}`,
  ];
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function commitRebaseStep(ctx: GitContext, repo: Repository, step: RebaseStep, announce = false): Promise<'ok' | 'stop'> {
  const op = repo.op;
  if (op?.kind !== 'rebase') return 'ok';
  const co = repo.objects.commit(step.commit);
  const head = repo.headHash()!;
  const next = op.todo[0];
  const continuingSquash = next && (next.action === 'squash' || next.action === 'fixup');

  if (step.action === 'squash' || step.action === 'fixup') {
    const prev = repo.objects.commit(head);
    op.squashMessages = op.squashMessages ?? [prev.message.replace(/\n+$/, '')];
    if (step.action === 'squash') op.squashMessages.push(co.message.replace(/\n+$/, ''));
    else op.squashMessages.push(`# fixup: ${subject(co.message)}`);
    let message: string;
    const hasSquash = op.squashMessages.slice(1).some((m) => !m.startsWith('# fixup:'));
    if (continuingSquash) {
      message = op.squashMessages.filter((m) => !m.startsWith('# fixup:')).join('\n\n');
    } else if (hasSquash) {
      const n = op.squashMessages.length;
      const body = [`# This is a combination of ${n} commits.`];
      op.squashMessages.forEach((m, i) => {
        if (m.startsWith('# fixup:')) {
          body.push(`# The commit message #${i + 1} will be skipped:`, '', `# ${m.slice(9)}`, '');
        } else {
          body.push(i === 0 ? '# This is the 1st commit message:' : `# This is the commit message #${i + 1}:`, '', m, '');
        }
      });
      const edited = await ctx.editor('.git/COMMIT_EDITMSG', body.join('\n') + '\n');
      message = cleanMessage(edited ?? op.squashMessages.filter((m) => !m.startsWith('# fixup:')).join('\n\n'));
      if (!message) message = op.squashMessages[0];
      op.squashMessages = null;
    } else {
      message = op.squashMessages[0];
      op.squashMessages = null;
    }
    const tree = repo.writeTree(repo.index);
    const nh = repo.makeCommit(tree, prev.parents, message, { author: prev.author });
    repo.moveHead(nh, `rebase (${step.action}): ${subject(message)}`);
    void ordinal;
    return 'ok';
  }

  let message = co.message;
  if (step.action === 'reword') {
    const edited = await ctx.editor('.git/COMMIT_EDITMSG', `${co.message.replace(/\n+$/, '')}\n\n# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.\n#\n# interactive rebase in progress; onto ${shortHash(op.onto)}\n`);
    const cleaned = edited === null ? '' : cleanMessage(edited);
    if (cleaned) message = cleaned;
  }
  const tree = repo.writeTree(repo.index);
  const nh = repo.makeCommit(tree, [head], message, { author: co.author });
  repo.moveHead(nh, `rebase (${step.action === 'edit' ? 'edit' : step.action}): ${subject(message)}`);
  if (step.action === 'reword' || announce) {
    print(ctx, `[detached HEAD ${shortHash(nh)}] ${subject(message)}`);
    if (announce) print(ctx, ...commitSummary(repo, diffFileMaps(repo.commitFiles(head), repo.commitFiles(nh))));
  }
  if (step.action === 'edit') {
    op.stopReason = 'edit';
    op.done.push(step);
    op.current = null;
    print(
      ctx,
      `Stopped at ${shortHash(step.commit)}...  ${subject(co.message)}`,
      'You can amend the commit now, with',
      '',
      '  git commit --amend ',
      '',
      'Once you are satisfied with your changes, run',
      '',
      '  git rebase --continue',
    );
    return 'stop';
  }
  return 'ok';
}

/** Run the remaining todo list. Returns an exit code. */
async function runRebase(ctx: GitContext, repo: Repository): Promise<number> {
  for (;;) {
    const op = repo.op;
    if (op?.kind !== 'rebase') return 0;
    const step = op.todo.shift();
    if (!step) break;
    op.current = step;
    op.stopReason = null;
    if (step.action === 'drop') {
      op.done.push(step);
      op.current = null;
      continue;
    }
    const co = repo.objects.commit(step.commit);
    const head = repo.headHash()!;
    op.stepBase = head;

    // Fast path: the commit already sits on HEAD; reuse it as-is (same hash).
    if (step.action === 'pick' && co.parents[0] === head && !op.squashMessages) {
      repo.resetTo(repo.commitFiles(step.commit), { worktree: true });
      repo.moveHead(step.commit, `rebase (pick): ${subject(co.message)}`);
      op.done.push(step);
      op.current = null;
      continue;
    }

    const parentFiles = co.parents.length ? repo.commitFiles(co.parents[0]) : new Map();
    const headFiles = repo.commitFiles(head);
    const r = mergeTrees(repo, parentFiles, headFiles, repo.commitFiles(step.commit), 'HEAD', `${shortHash(step.commit)} (${subject(co.message)})`);
    applyMergeResult(repo, headFiles, r);
    if (r.conflicts.size) {
      op.stopReason = 'conflict';
      print(ctx, ...r.messages, ...rebaseConflictHints(step.commit, subject(co.message)));
      ctx.world.emit({ type: 'rebase', stage: 'conflict', commit: step.commit, paths: [...r.conflicts.keys()] });
      return 1;
    }
    if (r.messages.length) print(ctx, ...r.messages);
    const unchanged = repo.writeTree(repo.index) === repo.objects.commit(head).tree;
    if (unchanged && step.action !== 'squash' && step.action !== 'fixup') {
      // Already upstream: drop it, like git does.
      op.done.push(step);
      op.current = null;
      continue;
    }
    const res = await commitRebaseStep(ctx, repo, step);
    if (res === 'stop') return 0;
    op.done.push(step);
    op.current = null;
  }
  return finishRebase(ctx, repo);
}

function finishRebase(ctx: GitContext, repo: Repository): number {
  const op = repo.op;
  if (op?.kind !== 'rebase') return 0;
  const newHead = repo.headHash()!;
  repo.op = null;
  if (op.headName) {
    const ref = `refs/heads/${op.headName}`;
    repo.setRef(ref, newHead, `rebase (finish): ${ref} onto ${op.onto}`);
    repo.attachHead(op.headName, `rebase (finish): returning to ${ref}`);
    print(ctx, `Successfully rebased and updated ${ref}.`);
  } else {
    print(ctx, 'Successfully rebased and updated detached HEAD.');
  }
  ctx.world.emit({ type: 'rebase', stage: 'done', branch: op.headName, head: newHead, onto: op.onto });
  return 0;
}

export async function cmdRebase(ctx: GitContext, argv: string[]): Promise<number> {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['--onto', '-s', '--strategy', '-X']);
  const op = repo.op?.kind === 'rebase' ? repo.op : null;

  if (a.has('--abort')) {
    if (!op) throw fatal('no rebase in progress');
    repo.resetTo(repo.commitFiles(op.origHead), { worktree: true });
    if (op.headName) {
      repo.op = null;
      repo.attachHead(op.headName, `rebase (abort): returning to refs/heads/${op.headName}`);
    } else {
      repo.op = null;
      repo.detachHead(op.origHead, 'rebase (abort): returning to original HEAD');
    }
    ctx.world.emit({ type: 'rebase', stage: 'abort' });
    return 0;
  }
  if (a.has('--quit')) {
    if (!op) throw fatal('no rebase in progress');
    repo.op = null;
    return 0;
  }
  if (a.has('--skip')) {
    if (!op) throw fatal('no rebase in progress');
    repo.resetTo(repo.headFiles(), { worktree: true });
    if (op.current) op.done.push(op.current);
    op.current = null;
    return runRebase(ctx, repo);
  }
  if (a.has('--continue')) {
    if (!op) throw fatal('no rebase in progress');
    if (repo.conflicts.size) {
      throw failure(
        `error: you must edit all merge conflicts and then\nmark them as resolved using git add\n` +
          [...repo.conflicts.keys()].map((p) => `${c.red('U')}\t${p}`).join('\n') ,
      );
    }
    if (op.stopReason === 'conflict' && op.current) {
      const step = op.current;
      const head = repo.headHash()!;
      if (head !== op.stepBase) {
        // The user already committed the resolution themselves.
        op.done.push(step);
        op.current = null;
      } else {
        const unchanged = repo.writeTree(repo.index) === repo.objects.commit(head).tree;
        if (unchanged && step.action !== 'squash' && step.action !== 'fixup') {
          throw failure(
            "No changes - did you forget to use 'git add'?\n" +
              'If there is nothing left to stage, chances are that something else\n' +
              'already introduced the same changes; you might want to skip this patch.\n' +
              rebaseConflictHints(step.commit, subject(repo.objects.commit(step.commit).message)).slice(1, -1).join('\n'),
          );
        }
        const res = await commitRebaseStep(ctx, repo, step, true);
        if (res === 'stop') return 0;
        op.done.push(step);
        op.current = null;
      }
    } else if (op.stopReason === 'edit') {
      if (repo.hasStagedChanges()) {
        throw failure(
          'error: you have staged changes in your working tree\n' +
            'If these changes are meant to be squashed into the previous commit, run:\n\n' +
            '  git commit --amend \n\n' +
            'If they are meant to go into a new commit, run:\n\n' +
            '  git commit \n\n' +
            'In both cases, once you\'re done, continue with:\n\n' +
            '  git rebase --continue\n',
        );
      }
    }
    return runRebase(ctx, repo);
  }

  if (repo.op) {
    if (op) throw fatal('It seems that there is already a rebase in progress.\nUse "git rebase --continue", "git rebase --skip" or "git rebase --abort".');
    assertNoOperation(repo, 'Rebasing');
  }

  // Work out upstream / branch / onto.
  let [upstreamSpec, branchArg] = a.rest;
  if (branchArg) {
    const saved = ctx.out.length;
    cmdCheckout(ctx, [branchArg]);
    ctx.out.length = saved;
  }
  const s = repo.status();
  if (s.unstaged.length) throw failure('error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.');
  if (s.staged.length) throw failure('error: cannot rebase: Your index contains uncommitted changes.\nerror: Please commit or stash them.');

  const branch = repo.currentBranch();
  if (!upstreamSpec) {
    const up = branch ? repo.upstreamOf(branch) : null;
    if (!up || !repo.getRef(up.ref)) {
      throw failure(
        'There is no tracking information for the current branch.\n' +
          'Please specify which branch you want to rebase against.\n' +
          'See git-rebase(1) for details.\n\n' +
          "    git rebase '<branch>'\n\n" +
          'If you wish to set tracking information for this branch you can do so with:\n\n' +
          `    git branch --set-upstream-to=<remote>/<branch> ${branch ?? '<branch>'}\n`,
      );
    }
    upstreamSpec = `${up.remote}/${up.branch}`;
  }
  const upstream = revParseCommit(repo, upstreamSpec);
  const ontoSpec = a.value('--onto');
  const onto = ontoSpec ? revParseCommit(repo, ontoSpec) : upstream;
  const head = repo.headHash();
  if (!head) throw fatal('no commits yet');
  const interactive = a.has('-i', '--interactive');

  // Commits to replay: in HEAD but not in upstream, oldest first, skipping merges.
  const candidates = walk(repo, { include: [head], exclude: [upstream] }).filter((h) => repo.parents(h).length <= 1).reverse();
  const upstreamIds = new Set(walk(repo, { include: [upstream], exclude: [head] }).map((h) => patchId(repo, h)));
  const skipped = candidates.filter((h) => upstreamIds.has(patchId(repo, h)));
  const commits = candidates.filter((h) => !skipped.includes(h));

  if (!interactive) {
    if (!commits.length && repo.isAncestor(onto, head) && !skipped.length) {
      print(ctx, `Current branch ${branch ?? 'HEAD'} is up to date.`);
      return 0;
    }
    if (commits.length && repo.isAncestor(onto, head) && repo.parents(commits[0])[0] === onto && !skipped.length) {
      print(ctx, `Current branch ${branch ?? 'HEAD'} is up to date.`);
      return 0;
    }
  }

  let todo: RebaseStep[] = commits.map((h) => ({ action: 'pick', commit: h }));
  if (interactive) {
    const lines = todo.map((s) => `pick ${shortHash(s.commit)} ${subject(repo.objects.commit(s.commit).message)}`);
    const range = `${shortHash(upstream)}..${shortHash(head)}`;
    const text = `${lines.join('\n')}\n\n# Rebase ${range} onto ${shortHash(onto)} (${plural(lines.length, 'command')})${TODO_HELP}\n`;
    const edited = await ctx.editor('.git/rebase-merge/git-rebase-todo', lines.length ? text : `noop\n${text}`);
    if (edited === null) {
      print(ctx, 'error: nothing to do');
      return 1;
    }
    todo = parseTodo(repo, edited.replace(/^noop$/m, ''));
    if (!todo.length) {
      print(ctx, 'error: nothing to do');
      return 1;
    }
  }

  for (const h of skipped) {
    print(
      ctx,
      `warning: skipped previously applied commit ${shortHash(h)}`,
      'hint: use --reapply-cherry-picks to include skipped commits',
      'hint: Disable this message with "git config advice.skippedCherryPicks false"',
    );
  }

  ensureIdentity(ctx, repo);
  repo.special.set('ORIG_HEAD', head);
  repo.op = {
    kind: 'rebase',
    interactive,
    headName: branch,
    origHead: head,
    onto,
    todo,
    done: [],
    current: null,
    stopReason: null,
    stepBase: null,
    squashMessages: null,
    total: todo.length,
  };
  repo.resetTo(repo.commitFiles(onto), { worktree: true });
  repo.detachHead(onto, `rebase (start): checkout ${ontoSpec ?? upstreamSpec}`);
  ctx.world.emit({ type: 'rebase', stage: 'start', onto, branch });
  return runRebase(ctx, repo);
}

export { hasConflictMarkers };
