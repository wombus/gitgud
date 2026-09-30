import { c } from '../ansi';
import { filterBySpecs, pathspecs, print, repoRoot, requireRepo, type GitContext } from '../context';
import { aheadBehind, cleanMessage, trackingInfo } from '../format';
import { shortHash, subject, type Hash } from '../objects';
import type { Repository } from '../repo';
import { dwimRef, previousBranch, revParseCommit, tryRevParse } from '../revparse';
import { Args, failure, fatal, GitError, plural } from '../util';

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

export function validBranchName(name: string): boolean {
  if (!name || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.endsWith('.lock') || name === 'HEAD' || name === '@') return false;
  if (/[\s~^:?*[\\]|\.\.|@\{|\/\/|\x7f/.test(name)) return false;
  return !name.split('/').some((part) => part.startsWith('.'));
}

function assertValidBranchName(name: string): void {
  if (!validBranchName(name)) throw fatal(`'${name}' is not a valid branch name`);
}

/** If exactly one remote has a branch with this name, return "origin/name". */
function guessRemoteBranch(repo: Repository, name: string): string | null {
  const matches = repo.remotes().filter((r) => repo.refs.has(`refs/remotes/${r}/${name}`));
  return matches.length === 1 ? `${matches[0]}/${name}` : null;
}

/** Commits that would become unreachable if HEAD moved away from `from`. */
function orphanedCommits(repo: Repository, from: Hash, target: Hash): Hash[] {
  const keep = repo.reachable([...repo.refs.values()].map((h) => repo.objects.peel(h)).concat(target, ...repo.stash));
  const out: Hash[] = [];
  const stack = [from];
  const seen = new Set<Hash>();
  while (stack.length) {
    const h = stack.pop()!;
    if (seen.has(h) || keep.has(h)) continue;
    seen.add(h);
    out.push(h);
    stack.push(...repo.parents(h));
  }
  return out;
}

function throwBlockers(dirty: string[], untracked: string[], verb: 'checkout' | 'merge' = 'checkout'): void {
  if (dirty.length) {
    throw failure(
      `error: Your local changes to the following files would be overwritten by ${verb}:\n` +
        dirty.map((p) => `\t${p}`).join('\n') +
        `\nPlease commit your changes or stash them before you ${verb === 'checkout' ? 'switch branches' : 'merge'}.\nAborting`,
    );
  }
  if (untracked.length) {
    throw failure(
      `error: The following untracked working tree files would be overwritten by ${verb}:\n` +
        untracked.map((p) => `\t${p}`).join('\n') +
        `\nPlease move or remove them before you ${verb === 'checkout' ? 'switch branches' : 'merge'}.\nAborting`,
    );
  }
}

export interface MoveOptions {
  /** Branch to attach HEAD to (null = detach). */
  branch: string | null;
  target: Hash;
  /** What the user typed, for reflog + messages. */
  label: string;
  force?: boolean;
  /** Print "Switched to a new branch" instead. */
  created?: boolean;
  quiet?: boolean;
}

/**
 * The heart of checkout/switch: move HEAD to a branch or commit, updating the index
 * and working tree while carrying uncommitted changes along when it's safe to.
 */
export function moveTo(ctx: GitContext, repo: Repository, o: MoveOptions): void {
  const fromHash = repo.headHash();
  const fromLabel = repo.currentBranch() ?? fromHash ?? 'HEAD';
  const targetFiles = repo.commitFiles(o.target);

  if (o.force) {
    repo.resetTo(targetFiles, { worktree: true });
  } else {
    const { dirty, untracked } = repo.switchBlockers(targetFiles);
    throwBlockers(dirty, untracked);
  }

  const wasDetached = repo.head.kind === 'detached';
  const lines: string[] = [];

  if (wasDetached && fromHash && fromHash !== o.target) {
    const lost = orphanedCommits(repo, fromHash, o.target);
    if (lost.length) {
      lines.push(
        `Warning: you are leaving ${plural(lost.length, 'commit')} behind, not connected to`,
        'any of your branches:',
        '',
        ...lost.slice(0, 4).map((h) => `  ${shortHash(h)} ${subject(repo.objects.commit(h).message)}`),
        ...(lost.length > 4 ? [` ... and ${lost.length - 4} more.`] : []),
        '',
        `If you want to keep ${lost.length > 1 ? 'them' : 'it'} by creating a new branch, this may be a good time`,
        'to do so with:',
        '',
        ` git branch <new-branch-name> ${shortHash(lost[0])}`,
        '',
      );
      ctx.world.emit({ type: 'orphaned', commits: lost });
    } else if (!o.branch) {
      lines.push(`Previous HEAD position was ${shortHash(fromHash)} ${subject(repo.objects.commit(fromHash).message)}`);
    }
  }

  if (!o.force) repo.switchTo(targetFiles);

  const msg = `checkout: moving from ${fromLabel} to ${o.branch ?? o.label}`;
  if (o.branch) {
    repo.attachHead(o.branch, msg);
  } else {
    // Like git, name the detach point after a ref (tag, remote branch) if one was used.
    const ref = o.label !== 'HEAD' ? dwimRef(repo, o.label) : null;
    repo.detachHead(o.target, msg, ref ? o.label : shortHash(o.target));
  }

  // Local modifications that came along for the ride.
  const carried = repo.status();
  const carriedLines = [
    ...carried.staged.map((s) => `${s.status}\t${s.path}`),
    ...carried.unstaged.filter((u) => !carried.staged.some((s) => s.path === u.path)).map((u) => `${u.status}\t${u.path}`),
  ];

  if (o.quiet) return;
  lines.push(...carriedLines);
  if (o.branch) {
    if (o.created) lines.push(`Switched to a new branch '${o.branch}'`);
    else lines.push(`Switched to branch '${o.branch}'`);
    lines.push(...trackingInfo(repo, o.branch));
  } else {
    if (!wasDetached) {
      lines.push(
        `Note: switching to '${o.label}'.`,
        '',
        "You are in 'detached HEAD' state. You can look around, make experimental",
        'changes and commit them, and you can discard any commits you make in this',
        'state without impacting any branches by switching back to a branch.',
        '',
        'If you want to create a new branch to retain commits you create, you may',
        'do so (now or later) by using -c with the switch command. Example:',
        '',
        '  git switch -c <new-branch-name>',
        '',
        'Or undo this operation with:',
        '',
        '  git switch -',
        '',
        'Turn off this advice by setting config variable advice.detachedHead to false',
        '',
      );
    }
    lines.push(`HEAD is now at ${shortHash(o.target)} ${subject(repo.objects.commit(o.target).message)}`);
  }
  print(ctx, ...lines);
  ctx.world.emit({ type: 'checkout', branch: o.branch, target: o.target });
}

function createBranch(
  ctx: GitContext,
  repo: Repository,
  name: string,
  startSpec: string | undefined,
  opts: { force?: boolean; track?: boolean | 'explicit'; quiet?: boolean } = {},
): Hash {
  assertValidBranchName(name);
  if (repo.branchHash(name) && !opts.force) throw fatal(`a branch named '${name}' already exists`);
  if (opts.force && repo.currentBranch() === name) throw fatal(`cannot force update the branch '${name}' used by worktree at '${repoRoot(ctx, repo)}'`);
  const spec = startSpec ?? 'HEAD';
  const start = tryRevParse(repo, spec);
  if (!start) {
    if (!repo.headHash() && spec === 'HEAD') throw fatal(`not a valid object name: '${repo.currentBranch() ?? 'HEAD'}'`);
    throw fatal(`not a valid object name: '${spec}'`);
  }
  const existed = repo.branchHash(name) !== undefined;
  repo.setRef(`refs/heads/${name}`, start, existed ? `branch: Reset to ${spec}` : `branch: Created from ${spec}`);

  // Starting from a remote-tracking branch sets up tracking automatically.
  const ref = startSpec ? dwimRef(repo, startSpec) : null;
  if (opts.track !== false && ref?.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
    const rest = ref.slice(13);
    const slash = rest.indexOf('/');
    repo.setUpstream(name, rest.slice(0, slash), rest.slice(slash + 1));
    if (!opts.quiet) print(ctx, `branch '${name}' set up to track '${rest}'.`);
  }
  ctx.world.emit({ type: 'branch-create', name, start });
  return start;
}

/* ------------------------------------------------------------------------- */
/* git branch                                                                 */
/* ------------------------------------------------------------------------- */

function headDescription(repo: Repository): string {
  const op = repo.op;
  if (op?.kind === 'rebase') return `(no branch, rebasing ${op.headName ?? 'detached HEAD'})`;
  if (repo.bisect) {
    const oh = repo.bisect.originalHead;
    return `(no branch, bisect started on ${oh.kind === 'branch' ? oh.name : shortHash(oh.hash)})`;
  }
  const d = repo.detachedFrom;
  const h = repo.headHash()!;
  if (d && d.hash === h) return `(HEAD detached at ${d.label})`;
  if (d) return `(HEAD detached from ${d.label})`;
  return `(HEAD detached at ${shortHash(h)})`;
}

export function cmdBranch(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['-u', '--set-upstream-to', '--contains', '--merged', '--no-merged', '--sort']);
  const verbose = argv.filter((x) => x === '-v' || x === '--verbose').length + argv.filter((x) => x === '-vv').length * 2;

  if (a.has('--show-current')) {
    const b = repo.currentBranch();
    if (b) print(ctx, b);
    return 0;
  }

  // Delete
  if (a.has('-d', '-D', '--delete')) {
    const force = a.has('-D', '-f', '--force');
    if (!a.rest.length) throw fatal('branch name required');
    let code = 0;
    for (const name of a.rest) {
      if (a.has('-r', '--remotes')) {
        const ref = `refs/remotes/${name}`;
        const h = repo.getRef(ref);
        if (!h) {
          print(ctx, `error: remote-tracking branch '${name}' not found.`);
          code = 1;
          continue;
        }
        repo.deleteRef(ref);
        print(ctx, `Deleted remote-tracking branch ${name} (was ${shortHash(h)}).`);
        continue;
      }
      const h = repo.branchHash(name);
      if (!h) {
        print(ctx, `error: branch '${name}' not found.`);
        code = 1;
        continue;
      }
      if (repo.currentBranch() === name) {
        print(ctx, `error: cannot delete branch '${name}' used by worktree at '${repoRoot(ctx, repo)}'`);
        code = 1;
        continue;
      }
      if (!force) {
        const up = repo.upstreamOf(name);
        const upHash = up ? repo.getRef(up.ref) : undefined;
        const against = upHash ?? repo.headHash();
        if (against && !repo.isAncestor(h, against)) {
          print(
            ctx,
            `error: the branch '${name}' is not fully merged.`,
            `If you are sure you want to delete it, run 'git branch -D ${name}'.`,
          );
          code = 1;
          continue;
        }
      }
      repo.deleteRef(`refs/heads/${name}`);
      repo.unsetUpstream(name);
      print(ctx, `Deleted branch ${name} (was ${shortHash(h)}).`);
      ctx.world.emit({ type: 'branch-delete', name, hash: h });
    }
    return code;
  }

  // Rename
  if (a.has('-m', '-M', '--move')) {
    const force = a.has('-M');
    let [oldName, newName] = a.rest;
    if (!newName) {
      newName = oldName;
      oldName = repo.currentBranch() ?? '';
    }
    if (!oldName || !newName) throw fatal('branch name required');
    const h = repo.branchHash(oldName);
    if (!h) throw fatal(`no branch named '${oldName}'`);
    assertValidBranchName(newName);
    if (repo.branchHash(newName) && !force) throw fatal(`a branch named '${newName}' already exists`);
    repo.refs.delete(`refs/heads/${oldName}`);
    const log = repo.reflogs.get(`refs/heads/${oldName}`) ?? [];
    repo.reflogs.delete(`refs/heads/${oldName}`);
    repo.refs.set(`refs/heads/${newName}`, h);
    repo.reflogs.set(`refs/heads/${newName}`, log);
    repo.appendReflog(`refs/heads/${newName}`, h, h, `Branch: renamed refs/heads/${oldName} to refs/heads/${newName}`);
    const up = repo.upstreamOf(oldName);
    repo.unsetUpstream(oldName);
    if (up) repo.setUpstream(newName, up.remote, up.branch);
    if (repo.currentBranch() === oldName) repo.head = { kind: 'branch', name: newName };
    ctx.world.emit({ type: 'branch-rename', from: oldName, to: newName });
    return 0;
  }

  // Upstream management
  const setUp = a.value('-u', '--set-upstream-to');
  if (setUp) {
    const branch = a.rest[0] ?? repo.currentBranch();
    if (!branch) throw fatal('could not set upstream of HEAD to ' + setUp + ' when it does not point to any branch.');
    if (!repo.branchHash(branch)) throw fatal(`branch '${branch}' does not exist`);
    const ref = dwimRef(repo, setUp);
    if (!ref || !ref.startsWith('refs/remotes/')) {
      throw fatal(`the requested upstream branch '${setUp}' does not exist\nhint: If you are planning on basing your work on an upstream\nhint: branch that already exists at the remote, you may need to\nhint: run "git fetch" to retrieve it.`);
    }
    const rest = ref.slice(13);
    const slash = rest.indexOf('/');
    repo.setUpstream(branch, rest.slice(0, slash), rest.slice(slash + 1));
    print(ctx, `branch '${branch}' set up to track '${rest}'.`);
    return 0;
  }
  if (a.has('--unset-upstream')) {
    const branch = a.rest[0] ?? repo.currentBranch();
    if (!branch || !repo.upstreamOf(branch)) throw fatal(`branch '${branch}' has no upstream information`);
    repo.unsetUpstream(branch);
    return 0;
  }

  // Create
  const listing = a.has('-l', '--list', '-a', '--all', '-r', '--remotes', '--merged', '--no-merged', '--contains') || !a.rest.length;
  if (!listing) {
    const [name, start] = a.rest;
    createBranch(ctx, repo, name, start, { force: a.has('-f', '--force'), track: a.has('--no-track') ? false : true });
    return 0;
  }

  // List
  const showLocal = !a.has('-r', '--remotes') || a.has('-a', '--all');
  const showRemote = a.has('-r', '--remotes', '-a', '--all');
  const pattern = a.has('-l', '--list') ? a.rest[0] : undefined;
  const patRe = pattern ? new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;

  let filter: (h: Hash) => boolean = () => true;
  const merged = a.value('--merged');
  const noMerged = a.value('--no-merged');
  const contains = a.value('--contains');
  if (a.has('--merged')) {
    const base = revParseCommit(repo, merged ?? 'HEAD');
    filter = (h) => repo.isAncestor(h, base);
  } else if (a.has('--no-merged')) {
    const base = revParseCommit(repo, noMerged ?? 'HEAD');
    filter = (h) => !repo.isAncestor(h, base);
  } else if (contains) {
    const target = revParseCommit(repo, contains);
    filter = (h) => repo.isAncestor(target, h);
  }

  interface Row {
    marker: string;
    name: string;
    colored: string;
    hash: Hash;
    extra?: string;
  }
  const rows: Row[] = [];
  if (showLocal) {
    if (repo.head.kind === 'detached' && !pattern) {
      const h = repo.headHash()!;
      if (filter(h)) rows.push({ marker: '*', name: headDescription(repo), colored: c.green(headDescription(repo)), hash: h });
    }
    for (const b of repo.branches()) {
      if (patRe && !patRe.test(b)) continue;
      const h = repo.branchHash(b)!;
      if (!filter(h)) continue;
      const cur = repo.currentBranch() === b;
      let extra = '';
      if (verbose) {
        const up = repo.upstreamOf(b);
        const ab = aheadBehind(repo, b);
        const parts: string[] = [];
        if (ab?.gone) parts.push('gone');
        else if (ab) {
          if (ab.ahead) parts.push(`ahead ${ab.ahead}`);
          if (ab.behind) parts.push(`behind ${ab.behind}`);
        }
        if (verbose >= 2 && up) extra = `[${c.blue(`${up.remote}/${up.branch}`)}${parts.length ? ': ' + parts.join(', ') : ''}] `;
        else if (parts.length) extra = `[${parts.join(', ')}] `;
      }
      rows.push({ marker: cur ? '*' : ' ', name: b, colored: cur ? c.green(b) : b, hash: h, extra });
    }
  }
  if (showRemote) {
    const prefix = showLocal ? 'remotes/' : '';
    for (const r of repo.remotes()) {
      const sym = repo.symrefs.get(`refs/remotes/${r}/HEAD`);
      const headRef = repo.getRef(`refs/remotes/${r}/HEAD`);
      if (sym && headRef && !verbose) {
        const target = sym.slice('refs/remotes/'.length);
        rows.push({ marker: ' ', name: `${prefix}${r}/HEAD`, colored: `${c.red(`${prefix}${r}/HEAD`)} -> ${target}`, hash: headRef });
      }
    }
    for (const rb of repo.remoteBranches()) {
      if (patRe && !patRe.test(rb)) continue;
      const h = repo.getRef(`refs/remotes/${rb}`)!;
      if (!filter(h)) continue;
      rows.push({ marker: ' ', name: `${prefix}${rb}`, colored: c.red(`${prefix}${rb}`), hash: h });
    }
  }
  const w = Math.max(0, ...rows.map((r) => r.name.length));
  for (const r of rows) {
    if (verbose) {
      const pad = ' '.repeat(Math.max(0, w - r.name.length));
      print(ctx, `${r.marker} ${r.colored}${pad} ${c.yellow(shortHash(r.hash))} ${r.extra ?? ''}${subject(repo.objects.commit(r.hash).message)}`);
    } else {
      print(ctx, `${r.marker} ${r.colored}`);
    }
  }
  return 0;
}

/* ------------------------------------------------------------------------- */
/* git checkout / git switch                                                  */
/* ------------------------------------------------------------------------- */

function checkoutPaths(ctx: GitContext, repo: Repository, source: string | null, args: string[], ours: boolean, theirs: boolean): number {
  const specs = pathspecs(ctx, repo, args);
  const files = source ? repo.commitFiles(revParseCommit(repo, source)) : repo.index;
  const known = new Set([...files.keys(), ...repo.conflicts.keys()]);
  if (!source) for (const p of repo.index.keys()) known.add(p);
  let count = 0;
  for (let i = 0; i < specs.length; i++) {
    const matches = filterBySpecs(known, [specs[i]]);
    if (!matches.length) throw failure(`error: pathspec '${args[i]}' did not match any file(s) known to git`);
    for (const p of matches) {
      const conflict = repo.conflicts.get(p);
      if (conflict && !source) {
        if (!ours && !theirs) throw failure(`error: path '${p}' is unmerged`);
        const h = ours ? conflict.ours : conflict.theirs;
        if (h === undefined) throw failure(`error: path '${p}' does not have ${ours ? 'our' : 'their'} version`);
        repo.worktree.set(p, repo.blob(h));
        count++;
        continue;
      }
      const h = files.get(p);
      if (h === undefined) continue;
      if (source) {
        repo.conflicts.delete(p);
        repo.index.set(p, h);
      }
      repo.worktree.set(p, repo.blob(h));
      count++;
    }
  }
  print(ctx, `Updated ${plural(count, 'path')} from ${source ? 'the tree' : 'the index'}`);
  ctx.world.emit({ type: 'checkout-paths', paths: specs, source });
  return 0;
}

export function cmdCheckout(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['-b', '-B', '--orphan']);
  const force = a.has('-f', '--force');
  const ours = a.has('--ours');
  const theirs = a.has('--theirs');
  const quiet = a.has('-q', '--quiet');

  if (a.has('-p', '--patch')) throw fatal('interactive checkout is not available on this machine');
  if (a.value('--orphan')) throw fatal('orphan branches are not supported on this machine (they give Legal nightmares)');

  // Paths after `--`
  if (a.afterDashDash) {
    return checkoutPaths(ctx, repo, a.rest[0] ?? null, a.afterDashDash, ours, theirs);
  }

  const newBranch = a.value('-b', '-B');
  if (newBranch) {
    const start = a.rest[0];
    const guessedTrack = a.has('-t', '--track') && start ? start : undefined;
    let startSpec = start ?? guessedTrack;
    if (!startSpec && a.has('-t', '--track')) throw fatal('missing branch name; try -b');
    const target = tryRevParse(repo, startSpec ?? 'HEAD');
    if (!target) {
      if (!startSpec && !repo.headHash()) {
        // Unborn branch: just rename what HEAD points at.
        assertValidBranchName(newBranch);
        repo.head = { kind: 'branch', name: newBranch };
        print(ctx, `Switched to a new branch '${newBranch}'`);
        return 0;
      }
      throw fatal(`'${startSpec}' is not a commit and a branch '${newBranch}' cannot be created from it`);
    }
    if (repo.branchHash(newBranch) && !a.has('-B')) throw fatal(`a branch named '${newBranch}' already exists`);
    assertValidBranchName(newBranch);
    // Check blockers before creating the branch so a failed switch doesn't leave it behind.
    if (!force) {
      const { dirty, untracked } = repo.switchBlockers(repo.commitFiles(target));
      throwBlockers(dirty, untracked);
    }
    createBranch(ctx, repo, newBranch, startSpec, { force: a.has('-B'), track: a.has('--no-track') ? false : true, quiet });
    moveTo(ctx, repo, { branch: newBranch, target, label: newBranch, force, created: true, quiet });
    return 0;
  }

  if (a.has('--track', '-t') && a.rest[0]) {
    const remoteRef = a.rest[0];
    const name = remoteRef.split('/').slice(1).join('/');
    return cmdCheckout(ctx, ['-b', name, '--track', remoteRef]);
  }

  if (!a.rest.length) {
    if (a.has('--detach')) {
      const h = repo.headHash();
      if (!h) throw fatal('You are on a branch yet to be born');
      moveTo(ctx, repo, { branch: null, target: h, label: 'HEAD', force, quiet });
      return 0;
    }
    // `git checkout` with no args just reports tracking info.
    const b = repo.currentBranch();
    if (b) print(ctx, ...trackingInfo(repo, b));
    return 0;
  }

  let [target, ...restPaths] = a.rest;
  if (target === '-') {
    const prev = previousBranch(repo);
    if (!prev) throw fatal('ambiguous argument \'@{-1}\': unknown revision or path not in the working tree.');
    target = prev;
  }

  // 1. A local branch
  if (repo.branchHash(target) && !restPaths.length) {
    if (repo.currentBranch() === target && !force) {
      print(ctx, `Already on '${target}'`, ...trackingInfo(repo, target));
      return 0;
    }
    moveTo(ctx, repo, { branch: target, target: repo.branchHash(target)!, label: target, force, quiet });
    return 0;
  }

  // 2. Any commit-ish -> detached HEAD
  const commit = tryRevParse(repo, target);
  if (commit && !restPaths.length) {
    if (a.has('--detach') || !repo.branchHash(target)) {
      if (repo.head.kind === 'detached' && repo.headHash() === commit) {
        print(ctx, `HEAD is now at ${shortHash(commit)} ${subject(repo.objects.commit(commit).message)}`);
        return 0;
      }
      moveTo(ctx, repo, { branch: null, target: commit, label: target, force, quiet });
      return 0;
    }
  }
  if (commit && restPaths.length) return checkoutPaths(ctx, repo, target, restPaths, ours, theirs);

  // 3. DWIM: a remote branch of the same name
  const guess = guessRemoteBranch(repo, target);
  if (guess && !restPaths.length) {
    return cmdCheckout(ctx, ['-b', target, '--track', guess]);
  }

  // 4. Paths
  return checkoutPaths(ctx, repo, null, a.rest, ours, theirs);
}

export function cmdSwitch(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['-c', '--create', '-C', '--force-create']);
  const force = a.has('-f', '--force', '--discard-changes');
  const quiet = a.has('-q', '--quiet');
  const create = a.value('-c', '--create', '-C', '--force-create');

  if (create) {
    const start = a.rest[0];
    const target = tryRevParse(repo, start ?? 'HEAD');
    if (!target) {
      if (!start && !repo.headHash()) {
        assertValidBranchName(create);
        repo.head = { kind: 'branch', name: create };
        print(ctx, `Switched to a new branch '${create}'`);
        return 0;
      }
      throw fatal(`invalid reference: ${start}`);
    }
    if (repo.branchHash(create) && !a.has('-C', '--force-create')) throw fatal(`a branch named '${create}' already exists`);
    assertValidBranchName(create);
    if (!force) {
      const { dirty, untracked } = repo.switchBlockers(repo.commitFiles(target));
      throwBlockers(dirty, untracked);
    }
    createBranch(ctx, repo, create, start, { force: a.has('-C', '--force-create'), track: a.has('--no-track') ? false : true, quiet });
    moveTo(ctx, repo, { branch: create, target, label: create, force, created: true, quiet });
    return 0;
  }

  if (a.has('--detach', '-d')) {
    const spec = a.rest[0] ?? 'HEAD';
    const target = revParseCommit(repo, spec);
    moveTo(ctx, repo, { branch: null, target, label: spec, force, quiet });
    return 0;
  }

  if (a.has('-t', '--track') && a.rest[0]) {
    const remoteRef = a.rest[0];
    return cmdSwitch(ctx, ['-c', remoteRef.split('/').slice(1).join('/'), remoteRef]);
  }

  let target = a.rest[0];
  if (!target) throw fatal('missing branch or commit argument');
  if (target === '-') {
    const prev = previousBranch(repo);
    if (!prev) throw fatal("invalid reference: @{-1}");
    target = prev;
  }
  const h = repo.branchHash(target);
  if (h) {
    if (repo.currentBranch() === target) {
      print(ctx, `Already on '${target}'`, ...trackingInfo(repo, target));
      return 0;
    }
    moveTo(ctx, repo, { branch: target, target: h, label: target, force, quiet });
    return 0;
  }
  const guess = guessRemoteBranch(repo, target);
  if (guess) return cmdSwitch(ctx, ['-c', target, guess]);

  const commit = tryRevParse(repo, target);
  if (commit) {
    // A previous-branch lookup that resolves to a detached commit is fine.
    if (a.rest[0] === '-') {
      moveTo(ctx, repo, { branch: null, target: commit, label: target, force, quiet });
      return 0;
    }
    const ref = dwimRef(repo, target);
    let kind = 'commit';
    if (ref?.startsWith('refs/tags/')) kind = 'tag';
    else if (ref?.startsWith('refs/remotes/')) kind = 'remote branch';
    throw new GitError(
      `fatal: a branch is expected, got ${kind} '${target}'\n` +
        `hint: If you want to detach HEAD at the commit, try again with the --detach option.`,
      128,
    );
  }
  throw fatal(`invalid reference: ${target}`);
}

/* ------------------------------------------------------------------------- */
/* git tag                                                                    */
/* ------------------------------------------------------------------------- */

export async function cmdTag(ctx: GitContext, argv: string[]): Promise<number> {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['-m', '--message', '-n']);
  if (a.has('-d', '--delete')) {
    let code = 0;
    for (const t of a.rest) {
      const h = repo.getRef(`refs/tags/${t}`);
      if (!h) {
        print(ctx, `error: tag '${t}' not found.`);
        code = 1;
        continue;
      }
      repo.deleteRef(`refs/tags/${t}`);
      print(ctx, `Deleted tag '${t}' (was ${shortHash(h)})`);
    }
    return code;
  }
  const listing = a.has('-l', '--list') || !a.rest.length;
  if (listing && !a.has('-a', '-m', '--message', '--annotate')) {
    const pattern = a.rest[0];
    const re = pattern ? new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;
    const showN = a.has('-n') || argv.some((x) => /^-n\d*$/.test(x));
    for (const t of repo.tags()) {
      if (re && !re.test(t)) continue;
      if (showN) {
        const raw = repo.getRef(`refs/tags/${t}`)!;
        const obj = repo.objects.get(raw);
        const line = obj?.type === 'tag' ? subject(obj.message) : subject(repo.objects.commit(repo.objects.peel(raw)).message);
        print(ctx, `${t.padEnd(15)} ${line}`);
      } else print(ctx, t);
    }
    return 0;
  }
  const [name, spec] = a.rest;
  if (!name) throw fatal('tag name required');
  if (!validBranchName(name)) throw fatal(`'${name}' is not a valid tag name.`);
  if (repo.getRef(`refs/tags/${name}`) && !a.has('-f', '--force')) throw fatal(`tag '${name}' already exists`);
  const target = revParseCommit(repo, spec ?? 'HEAD');
  const annotated = a.has('-a', '--annotate', '-m', '--message');
  if (annotated) {
    let message = a.values('-m', '--message').join('\n\n');
    if (!message) {
      const edited = await ctx.editor(`.git/TAG_EDITMSG`, `\n#\n# Write a message for tag:\n#   ${name}\n# Lines starting with '#' will be ignored.\n`);
      message = edited === null ? '' : cleanMessage(edited);
      if (!message) throw fatal('no tag message?');
    }
    const tagObj = repo.objects.put({ type: 'tag', object: target, tag: name, tagger: repo.signature(), message: message + '\n' });
    repo.refs.set(`refs/tags/${name}`, tagObj);
  } else {
    repo.refs.set(`refs/tags/${name}`, target);
  }
  ctx.world.emit({ type: 'tag', name, target, annotated });
  return 0;
}

