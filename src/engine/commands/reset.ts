import { filterBySpecs, pathspecs, print, requireRepo, type GitContext } from '../context';
import { shortHash, subject, type Hash } from '../objects';
import { revParseCommit, tryRevParse } from '../revparse';
import { Args, failure, fatal } from '../util';

/**
 * git reset moves the current branch to another commit, then optionally makes the
 * index (--mixed, the default) and working tree (--hard) match it:
 *
 *   --soft   branch moves; index and files untouched (changes show as staged)
 *   --mixed  branch moves; index reset; files untouched (changes show as unstaged)
 *   --hard   branch moves; index AND files reset (uncommitted work is gone)
 *
 * With paths (`git reset -- file`), it only copies entries into the index: the
 * classic way to unstage something.
 */
export function cmdReset(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv);
  const mode = a.has('--hard') ? 'hard' : a.has('--soft') ? 'soft' : a.has('--keep') ? 'keep' : a.has('--merge') ? 'merge' : 'mixed';
  const quiet = a.has('-q', '--quiet');
  let rev = 'HEAD';
  let paths: string[] = [...(a.afterDashDash ?? [])];
  const rest = [...a.rest];
  if (rest.length) {
    if (tryRevParse(repo, rest[0]) || (a.afterDashDash !== null && rest.length === 1)) {
      rev = rest.shift()!;
    }
    paths.push(...rest);
  }

  // Path mode: unstage.
  if (paths.length) {
    if (mode !== 'mixed') throw fatal(`Cannot do ${mode} reset with paths.`);
    const source = repo.headHash() || rev !== 'HEAD' ? repo.commitFiles(revParseCommit(repo, rev)) : new Map<string, Hash>();
    const specs = pathspecs(ctx, repo, paths);
    const known = new Set([...source.keys(), ...repo.index.keys(), ...repo.conflicts.keys()]);
    for (let i = 0; i < specs.length; i++) {
      const matches = filterBySpecs(known, [specs[i]]);
      if (!matches.length && !repo.worktree.has(specs[i])) {
        throw fatal(`ambiguous argument '${paths[i]}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
      }
      for (const p of matches) {
        repo.conflicts.delete(p);
        const h = source.get(p);
        if (h === undefined) repo.index.delete(p);
        else repo.index.set(p, h);
      }
    }
    if (!quiet) printUnstaged(ctx);
    ctx.world.emit({ type: 'reset', mode: 'paths', paths: specs });
    return 0;
  }

  const head = repo.headHash();
  if (!head) {
    if (rev !== 'HEAD') revParseCommit(repo, rev);
    repo.index.clear();
    repo.conflicts.clear();
    return 0;
  }
  const target = revParseCommit(repo, rev);
  const targetFiles = repo.commitFiles(target);

  if (mode === 'soft' && repo.op?.kind === 'merge') throw fatal('Cannot do a soft reset in the middle of a merge.');
  if (mode === 'keep') {
    const { dirty } = repo.switchBlockers(targetFiles);
    if (dirty.length) {
      throw failure(`error: Entry '${dirty[0]}' not uptodate. Cannot merge.\nfatal: Could not reset index file to revision '${rev}'.`, 128);
    }
  }

  repo.special.set('ORIG_HEAD', head);
  repo.moveHead(target, `reset: moving to ${rev}`);

  if (mode === 'mixed') repo.resetTo(targetFiles, { worktree: false });
  else if (mode === 'hard' || mode === 'merge') repo.resetTo(targetFiles, { worktree: true });
  else if (mode === 'keep') {
    const headFiles = repo.commitFiles(head);
    for (const p of new Set([...headFiles.keys(), ...targetFiles.keys()])) {
      if (headFiles.get(p) !== targetFiles.get(p)) repo.writePath(p, targetFiles.get(p));
    }
  }

  if (mode !== 'soft' && repo.op && repo.op.kind !== 'rebase') {
    repo.op = null;
    repo.special.delete('MERGE_HEAD');
    repo.special.delete('CHERRY_PICK_HEAD');
    repo.special.delete('REVERT_HEAD');
  }

  if (!quiet) {
    if (mode === 'hard' || mode === 'keep' || mode === 'merge') {
      print(ctx, `HEAD is now at ${shortHash(target)} ${subject(repo.objects.commit(target).message)}`);
    } else if (mode === 'mixed') {
      printUnstaged(ctx);
    }
  }
  ctx.world.emit({ type: 'reset', mode, from: head, to: target, branch: repo.currentBranch() });
  return 0;
}

function printUnstaged(ctx: GitContext): void {
  const repo = requireRepo(ctx);
  const s = repo.status();
  if (!s.unstaged.length) return;
  print(ctx, 'Unstaged changes after reset:', ...s.unstaged.map((u) => `${u.status}\t${u.path}`));
}
