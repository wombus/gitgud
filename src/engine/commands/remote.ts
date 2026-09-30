import { c } from '../ansi';
import { print, requireRepo, type GitContext } from '../context';
import type { HostedRepo } from '../hub';
import { ObjectStore, shortHash, type Hash } from '../objects';
import type { Repository } from '../repo';
import { dwimRef, tryRevParse } from '../revparse';
import { Args, failure, fatal, GitError } from '../util';
import { cmdRebase, doMerge } from './merging';

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

function displayUrl(url: string): string {
  return url.replace(/^git@/, '').replace(/^https?:\/\//, '');
}

function unreachable(): GitError {
  return new GitError(
    `ERROR: Repository not found.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`,
    128,
  );
}

function hosted(ctx: GitContext, repo: Repository, remote: string): { host: HostedRepo; url: string } {
  const url = repo.remoteUrl(remote);
  if (!url) {
    throw new GitError(
      `fatal: '${remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`,
      128,
    );
  }
  const host = ctx.world.hub.resolve(url);
  if (!host) throw unreachable();
  return { host, url };
}

function defaultRemote(repo: Repository): string {
  const b = repo.currentBranch();
  const up = b ? repo.upstreamOf(b) : null;
  if (up) return up.remote;
  const rs = repo.remotes();
  return rs.includes('origin') ? 'origin' : rs[0] ?? 'origin';
}

function countObjects(store: ObjectStore, tips: Hash[], have: (h: Hash) => boolean): number {
  // Rough "objects that would be transferred": commits the other side lacks, ~3 objects each.
  let n = 0;
  const seen = new Set<Hash>();
  const stack = [...tips];
  while (stack.length) {
    const h = store.peel(stack.pop()!);
    if (seen.has(h) || have(h)) continue;
    const o = store.get(h);
    if (o?.type !== 'commit') continue;
    seen.add(h);
    n += 3;
    stack.push(...o.parents);
  }
  return n;
}

const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

/** GitHub closes issues referenced as "Fixes #12" once the commit lands on the default branch. */
function closeReferencedIssues(host: HostedRepo, commits: Hash[], by: string): void {
  for (const h of commits) {
    const o = host.objects.get(h);
    if (o?.type !== 'commit') continue;
    for (const m of o.message.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) {
      const issue = host.issue(parseInt(m[1], 10));
      if (issue && issue.state === 'open') {
        issue.state = 'closed';
        issue.closedBy = by;
      }
    }
  }
}

export function hostedCommitsBetween(host: HostedRepo, from: Hash | null | undefined, to: Hash): Hash[] {
  const exclude = new Set<Hash>();
  if (from) {
    const st = [from];
    while (st.length) {
      const h = st.pop()!;
      if (exclude.has(h)) continue;
      exclude.add(h);
      const o = host.objects.get(h);
      if (o?.type === 'commit') st.push(...o.parents);
    }
  }
  const out: Hash[] = [];
  const st = [to];
  const seen = new Set<Hash>();
  while (st.length) {
    const h = st.pop()!;
    if (seen.has(h) || exclude.has(h)) continue;
    seen.add(h);
    out.push(h);
    const o = host.objects.get(h);
    if (o?.type === 'commit') st.push(...o.parents);
  }
  return out;
}

/** Update a hosted ref and run GitHub's side effects (issue auto-close). */
export function updateHostedRef(host: HostedRepo, ref: string, to: Hash | null, forced: boolean, by: string): void {
  const old = host.refs.get(ref) ?? null;
  if (to === null) host.refs.delete(ref);
  else host.refs.set(ref, to);
  host.events.push({ kind: 'push', repo: host.slug, ref, old, new: to, forced, by });
  if (to && ref === `refs/heads/${host.defaultBranch}`) {
    closeReferencedIssues(host, hostedCommitsBetween(host, old, to), by);
  }
}

/* ------------------------------------------------------------------------- */
/* git remote                                                                 */
/* ------------------------------------------------------------------------- */

export function cmdRemote(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv);
  const [sub, ...rest] = a.rest;
  if (!sub) {
    for (const r of repo.remotes()) {
      if (a.has('-v', '--verbose')) {
        print(ctx, `${r}\t${repo.remoteUrl(r)} (fetch)`, `${r}\t${repo.remoteUrl(r)} (push)`);
      } else print(ctx, r);
    }
    return 0;
  }
  switch (sub) {
    case 'add': {
      const [name, url] = rest;
      if (!name || !url) throw fatal('usage: git remote add <name> <url>');
      if (repo.remoteUrl(name)) throw failure(`error: remote ${name} already exists.`, 3);
      repo.setConfig(`remote.${name}.url`, url);
      repo.setConfig(`remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`);
      ctx.world.emit({ type: 'remote-add', name, url });
      return 0;
    }
    case 'remove':
    case 'rm': {
      const [name] = rest;
      if (!repo.remoteUrl(name)) throw failure(`error: No such remote: '${name}'`, 2);
      for (const k of [...repo.config.keys()]) if (k.startsWith(`remote.${name}.`)) repo.config.delete(k);
      for (const ref of [...repo.refs.keys()]) if (ref.startsWith(`refs/remotes/${name}/`)) repo.refs.delete(ref);
      repo.symrefs.delete(`refs/remotes/${name}/HEAD`);
      for (const b of repo.branches()) if (repo.upstreamOf(b)?.remote === name) repo.unsetUpstream(b);
      return 0;
    }
    case 'rename': {
      const [from, to] = rest;
      const url = repo.remoteUrl(from);
      if (!url) throw failure(`error: No such remote: '${from}'`, 2);
      if (repo.remoteUrl(to)) throw failure(`error: remote ${to} already exists.`, 3);
      for (const k of [...repo.config.keys()]) if (k.startsWith(`remote.${from}.`)) repo.config.delete(k);
      repo.setConfig(`remote.${to}.url`, url);
      repo.setConfig(`remote.${to}.fetch`, `+refs/heads/*:refs/remotes/${to}/*`);
      for (const [ref, h] of [...repo.refs]) {
        if (ref.startsWith(`refs/remotes/${from}/`)) {
          repo.refs.delete(ref);
          repo.refs.set(`refs/remotes/${to}/${ref.slice(14 + from.length)}`, h);
        }
      }
      const sym = repo.symrefs.get(`refs/remotes/${from}/HEAD`);
      repo.symrefs.delete(`refs/remotes/${from}/HEAD`);
      if (sym) repo.symrefs.set(`refs/remotes/${to}/HEAD`, sym.replace(`refs/remotes/${from}/`, `refs/remotes/${to}/`));
      for (const b of repo.branches()) {
        const up = repo.upstreamOf(b);
        if (up?.remote === from) repo.setUpstream(b, to, up.branch);
      }
      return 0;
    }
    case 'get-url': {
      const url = repo.remoteUrl(rest[0]);
      if (!url) throw failure(`error: No such remote '${rest[0]}'`, 2);
      print(ctx, url);
      return 0;
    }
    case 'set-url': {
      const [name, url] = rest;
      if (!repo.remoteUrl(name)) throw failure(`error: No such remote '${name}'`, 2);
      repo.setConfig(`remote.${name}.url`, url);
      return 0;
    }
    case 'show': {
      const name = rest[0] ?? 'origin';
      const { host, url } = hosted(ctx, repo, name);
      print(ctx, `* remote ${name}`, `  Fetch URL: ${url}`, `  Push  URL: ${url}`, `  HEAD branch: ${host.defaultBranch}`, '  Remote branches:');
      for (const b of host.branches()) {
        const tracked = repo.refs.has(`refs/remotes/${name}/${b}`);
        print(ctx, `    ${pad(b, 20)} ${tracked ? 'tracked' : 'new (next fetch will store in remotes/' + name + ')'}`);
      }
      const locals = repo.branches().filter((b) => repo.upstreamOf(b)?.remote === name);
      if (locals.length) {
        print(ctx, "  Local branches configured for 'git pull':");
        for (const b of locals) print(ctx, `    ${pad(b, 20)} merges with remote ${repo.upstreamOf(b)!.branch}`);
      }
      return 0;
    }
    case 'prune':
      return cmdFetch(ctx, ['--prune', rest[0] ?? 'origin']);
    default:
      throw failure(`error: unknown subcommand: \`${sub}'`, 129);
  }
}

/* ------------------------------------------------------------------------- */
/* git clone                                                                  */
/* ------------------------------------------------------------------------- */

export function cmdClone(ctx: GitContext, argv: string[]): number {
  const a = new Args(argv, ['-b', '--branch', '--depth', '-o', '--origin']);
  const url = a.rest[0];
  if (!url) throw fatal('You must specify a repository to clone.');
  if (ctx.dir) {
    throw fatal(`cloning inside another project is above your pay grade.\nhint: go back home first: cd ~`);
  }
  const host = ctx.world.hub.resolve(url);
  const name = a.rest[1] ?? url.replace(/\.git$/, '').replace(/\/$/, '').split(/[/:]/).pop()!;
  const existing = ctx.world.dirs.get(name);
  if (existing && (existing.initialized || existing.worktree.size)) {
    throw fatal(`destination path '${name}' already exists and is not an empty directory.`);
  }
  print(ctx, `Cloning into '${name}'...`);
  if (!host) throw unreachable();

  const repo = cloneInto(ctx, host, url, name, a.value('-b', '--branch'), a.value('-o', '--origin') ?? 'origin');
  const n = repo.objects.allHashes().length;
  const deltas = Math.floor(n / 3);
  if (n) {
    print(
      ctx,
      `remote: Enumerating objects: ${n}, done.`,
      `remote: Counting objects: 100% (${n}/${n}), done.`,
      `remote: Compressing objects: 100% (${Math.ceil(n * 0.7)}/${Math.ceil(n * 0.7)}), done.`,
      `remote: Total ${n} (delta ${deltas}), reused ${n - 2} (delta ${Math.max(0, deltas - 1)}), pack-reused 0`,
      `Receiving objects: 100% (${n}/${n}), ${(n * 0.31).toFixed(2)} KiB | 1.21 MiB/s, done.`,
      `Resolving deltas: 100% (${deltas}/${deltas}), done.`,
    );
  } else {
    print(ctx, 'warning: You appear to have cloned an empty repository.');
  }
  ctx.world.emit({ type: 'clone', url, name });
  return 0;
}

/** Create ~/name as a clone of `host`. Also used by level setup code. */
export function cloneInto(ctx: { world: GitContext['world'] }, host: HostedRepo, url: string, name: string, branch?: string, remote = 'origin'): Repository {
  const repo = ctx.world.createDir(name, true);
  repo.objects.copyReachable(host.objects, [...host.refs.values()]);
  repo.setConfig(`remote.${remote}.url`, url);
  repo.setConfig(`remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`);
  for (const [ref, h] of host.refs) {
    if (ref.startsWith('refs/heads/')) repo.setRefQuiet(`refs/remotes/${remote}/${ref.slice(11)}`, h);
    else if (ref.startsWith('refs/tags/')) repo.setRefQuiet(ref, h);
  }
  const defaultBranch = branch ?? host.defaultBranch;
  const tip = host.branchHash(defaultBranch);
  if (tip) {
    repo.symrefs.set(`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/${defaultBranch}`);
    repo.head = { kind: 'branch', name: defaultBranch };
    repo.setRef(`refs/heads/${defaultBranch}`, tip, `clone: from ${url}`);
    repo.appendReflog('HEAD', '0'.repeat(40), tip, `clone: from ${url}`);
    repo.setUpstream(defaultBranch, remote, defaultBranch);
    repo.resetTo(repo.commitFiles(tip), { worktree: true });
  } else if (branch) {
    throw fatal(`Remote branch ${branch} not found in upstream ${remote}`);
  }
  return repo;
}

/* ------------------------------------------------------------------------- */
/* git fetch                                                                  */
/* ------------------------------------------------------------------------- */

interface FetchResult {
  lines: string[];
  fetchHead: Hash | null;
}

function fetchFrom(ctx: GitContext, repo: Repository, remote: string, opts: { prune?: boolean; only?: string[] }): FetchResult {
  const { host, url } = hosted(ctx, repo, remote);
  const lines: string[] = [];
  const refLines: string[] = [];
  const width = Math.max(10, ...host.branches().map((b) => b.length));

  const tips = [...host.refs.values()];
  const newObjects = countObjects(host.objects, tips, (h) => repo.objects.has(h));
  repo.objects.copyReachable(host.objects, tips);

  let fetchHead: Hash | null = null;
  for (const b of host.branches()) {
    if (opts.only && !opts.only.includes(b)) continue;
    const h = host.branchHash(b)!;
    const ref = `refs/remotes/${remote}/${b}`;
    const old = repo.getRef(ref);
    if (opts.only) refLines.push(` * branch            ${pad(b, width)} -> FETCH_HEAD`);
    if (old === h) {
      if (!fetchHead) fetchHead = h;
      continue;
    }
    if (!old) refLines.push(` * ${c.green('[new branch]')}      ${pad(b, width)} -> ${remote}/${b}`);
    else if (repo.isAncestor(old, h)) refLines.push(`   ${shortHash(old)}..${shortHash(h)}  ${pad(b, width)} -> ${remote}/${b}`);
    else refLines.push(` + ${shortHash(old)}...${shortHash(h)} ${pad(b, width)} -> ${remote}/${b}  (forced update)`);
    repo.setRefQuiet(ref, h);
    repo.appendReflog(ref, old ?? '0'.repeat(40), h, old ? 'fetch: fast-forward' : 'fetch: storing head');
  }
  const cur = repo.currentBranch();
  const up = cur ? repo.upstreamOf(cur) : null;
  if (up?.remote === remote) fetchHead = host.branchHash(up.branch) ?? fetchHead;
  if (opts.only?.length) fetchHead = host.branchHash(opts.only[0]) ?? fetchHead;

  // Tags that point into fetched history come along automatically.
  for (const [ref, h] of host.refs) {
    if (!ref.startsWith('refs/tags/') || repo.refs.has(ref)) continue;
    repo.setRefQuiet(ref, h);
    const t = ref.slice(10);
    refLines.push(` * ${c.green('[new tag]')}         ${pad(t, width)} -> ${t}`);
  }

  if (!repo.symrefs.has(`refs/remotes/${remote}/HEAD`) && host.branchHash(host.defaultBranch)) {
    repo.symrefs.set(`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/${host.defaultBranch}`);
  }

  if (opts.prune) {
    for (const ref of [...repo.refs.keys()]) {
      if (!ref.startsWith(`refs/remotes/${remote}/`) || ref.endsWith('/HEAD')) continue;
      const b = ref.slice(14 + remote.length);
      if (!host.branchHash(b)) {
        repo.deleteRef(ref);
        refLines.push(` - ${c.red('[deleted]')}         ${pad('(none)', width)} -> ${remote}/${b}`);
      }
    }
  }

  if (newObjects) {
    const n = newObjects;
    lines.push(
      `remote: Enumerating objects: ${n}, done.`,
      `remote: Counting objects: 100% (${n}/${n}), done.`,
      `remote: Compressing objects: 100% (${Math.ceil(n / 2)}/${Math.ceil(n / 2)}), done.`,
      `remote: Total ${n} (delta ${Math.floor(n / 4)}), reused ${n - 1} (delta 0), pack-reused 0`,
      `Unpacking objects: 100% (${n}/${n}), ${(n * 0.29).toFixed(2)} KiB | 612.00 KiB/s, done.`,
    );
  }
  if (refLines.length) lines.push(`From ${displayUrl(url)}`, ...refLines);
  if (fetchHead) repo.special.set('FETCH_HEAD', fetchHead);
  ctx.world.emit({ type: 'fetch', remote });
  return { lines, fetchHead };
}

export function cmdFetch(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv);
  const prune = a.has('-p', '--prune');
  const remotes = a.has('--all') ? repo.remotes() : [a.rest[0] ?? defaultRemote(repo)];
  const only = a.rest.length > 1 ? a.rest.slice(1) : undefined;
  if (!remotes.length) return 0;
  for (const r of remotes) {
    if (a.has('--all')) print(ctx, `Fetching ${r}`);
    const res = fetchFrom(ctx, repo, r, { prune, only });
    print(ctx, ...res.lines);
  }
  return 0;
}

/* ------------------------------------------------------------------------- */
/* git pull                                                                   */
/* ------------------------------------------------------------------------- */

const DIVERGENT_HINT = [
  'hint: You have divergent branches and need to specify how to reconcile them.',
  'hint: You can do so by running one of the following commands sometime before',
  'hint: your next pull:',
  'hint:',
  'hint:   git config pull.rebase false  # merge',
  'hint:   git config pull.rebase true   # rebase',
  'hint:   git config pull.ff only       # fast-forward only',
  'hint:',
  'hint: You can replace "git config" with "git config --global" to set a default',
  'hint: preference for all repositories. You can also pass --rebase, --no-rebase,',
  'hint: or --ff-only on the command line to override the configured default per',
  'hint: invocation.',
  'fatal: Need to specify how to reconcile divergent branches.',
].join('\n');

export async function cmdPull(ctx: GitContext, argv: string[]): Promise<number> {
  const repo = requireRepo(ctx);
  const a = new Args(argv);
  const branch = repo.currentBranch();
  let remote = a.rest[0];
  let remoteBranch = a.rest[1];

  if (!remote) {
    const up = branch ? repo.upstreamOf(branch) : null;
    if (!up) {
      if (!branch) {
        throw failure(
          'You are not currently on a branch.\nPlease specify which branch you want to merge with.\nSee git-pull(1) for details.\n\n    git pull <remote> <branch>\n',
        );
      }
      throw failure(
        'There is no tracking information for the current branch.\n' +
          'Please specify which branch you want to merge with.\n' +
          'See git-pull(1) for details.\n\n' +
          '    git pull <remote> <branch>\n\n' +
          'If you wish to set tracking information for this branch you can do so with:\n\n' +
          `    git branch --set-upstream-to=origin/<branch> ${branch}\n`,
      );
    }
    remote = up.remote;
    remoteBranch = up.branch;
  }
  if (!remoteBranch) {
    const up = branch ? repo.upstreamOf(branch) : null;
    remoteBranch = up?.remote === remote ? up.branch : branch ?? '';
  }

  if (repo.op) {
    if (repo.op.kind === 'merge' && repo.conflicts.size) {
      throw new GitError(
        "error: Pulling is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.",
        128,
      );
    }
    throw fatal(`You have not concluded your ${repo.op.kind}. Finish it first.`);
  }

  const explicit = a.rest.length > 1;
  const res = fetchFrom(ctx, repo, remote, { only: explicit ? [remoteBranch] : undefined });
  print(ctx, ...res.lines);
  const target = repo.getRef(`refs/remotes/${remote}/${remoteBranch}`);
  if (!target) throw fatal(`couldn't find remote ref ${remoteBranch}`);
  const head = repo.headHash();

  const rebaseFlag = a.has('-r', '--rebase') ? true : a.has('--no-rebase') ? false : undefined;
  const cfgRebase = repo.getConfig('pull.rebase');
  const rebase = rebaseFlag ?? (cfgRebase === 'true' || cfgRebase === 'merges' || cfgRebase === 'interactive');
  const ffOnly = a.has('--ff-only') || (repo.getConfig('pull.ff') === 'only' && !a.has('--ff', '--no-ff') && rebaseFlag === undefined);
  const configured = rebaseFlag !== undefined || cfgRebase !== undefined || repo.getConfig('pull.ff') !== undefined || a.has('--ff-only', '--ff', '--no-ff');

  if (head && repo.isAncestor(target, head)) {
    print(ctx, 'Already up to date.');
    return 0;
  }
  const canFF = !head || repo.isAncestor(head, target);

  if (rebase) {
    const s = repo.status();
    if (s.unstaged.length) throw failure('error: cannot pull with rebase: You have unstaged changes.\nerror: Please commit or stash them.');
    if (s.staged.length) throw failure('error: cannot pull with rebase: Your index contains uncommitted changes.\nerror: Please commit or stash them.');
    return cmdRebase(ctx, [`${remote}/${remoteBranch}`]);
  }
  if (!canFF) {
    if (ffOnly) throw fatal('Not possible to fast-forward, aborting.');
    if (!configured) throw new GitError(DIVERGENT_HINT, 128);
  }
  const url = repo.remoteUrl(remote) ?? remote;
  return doMerge(ctx, repo, `${remote}/${remoteBranch}`, target, {
    message: `Merge branch '${remoteBranch}' of ${displayUrl(url).replace(/\.git$/, '')}`,
    reflogVerb: 'pull',
    noFF: a.has('--no-ff'),
  });
}

/* ------------------------------------------------------------------------- */
/* git push                                                                   */
/* ------------------------------------------------------------------------- */

interface PushSpec {
  src: string | null; // null = delete
  dst: string; // full ref on the remote
  force: boolean;
  label: string;
}

function parseRefspec(repo: Repository, spec: string, forceAll: boolean): PushSpec {
  let force = forceAll;
  if (spec.startsWith('+')) {
    force = true;
    spec = spec.slice(1);
  }
  const [srcRaw, dstRaw] = spec.includes(':') ? spec.split(':') : [spec, undefined];
  if (srcRaw === '') {
    const dst = dstRaw!.startsWith('refs/') ? dstRaw! : `refs/heads/${dstRaw}`;
    return { src: null, dst, force, label: dstRaw!.replace(/^refs\/(heads|tags)\//, '') };
  }
  const src = srcRaw === 'HEAD' ? 'HEAD' : srcRaw;
  let dst = dstRaw;
  if (!dst) {
    const ref = src === 'HEAD' ? (repo.currentBranch() ? `refs/heads/${repo.currentBranch()}` : null) : dwimRef(repo, src);
    if (!ref) throw fatal(`The destination you provided is not a full refname (i.e.,\nstarting with "refs/"). Try "git push origin HEAD:refs/heads/<name>".`);
    dst = ref.startsWith('refs/remotes/') ? `refs/heads/${ref.split('/').slice(3).join('/')}` : ref;
  } else if (!dst.startsWith('refs/')) {
    const srcRef = dwimRef(repo, src);
    dst = srcRef?.startsWith('refs/tags/') ? `refs/tags/${dst}` : `refs/heads/${dst}`;
  }
  return { src, dst, force, label: `${src === 'HEAD' ? 'HEAD' : src} -> ${dst.replace(/^refs\/(heads|tags)\//, '')}` };
}

export function cmdPush(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['-o', '--push-option']);
  const forceAll = a.has('-f', '--force');
  const leaseFlag = argv.find((x) => x.startsWith('--force-with-lease'));
  const setUpstream = a.has('-u', '--set-upstream');
  const del = a.has('-d', '--delete');
  const dry = a.has('-n', '--dry-run');
  const branch = repo.currentBranch();

  let remote = a.rest[0];
  let refArgs = a.rest.slice(1);
  if (remote && !repo.remoteUrl(remote) && !ctx.world.hub.resolve(remote)) {
    // Maybe they typed `git push main` meaning a branch.
    if (repo.branchHash(remote) && repo.remotes().length) {
      throw new GitError(
        `fatal: '${remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n${c.gray(`(did you mean: git push origin ${remote} ?)`)}`,
        128,
      );
    }
  }
  if (!remote && !repo.remotes().length) {
    throw new GitError(
      'fatal: No configured push destination.\n' +
        'Either specify the URL from the command-line or configure a remote repository using\n\n' +
        '    git remote add <name> <url>\n\n' +
        'and then push using the remote name\n\n' +
        '    git push <name>\n',
      128,
    );
  }
  if (!remote) remote = defaultRemote(repo);
  const { host, url } = hosted(ctx, repo, remote);

  const specs: PushSpec[] = [];
  if (del) {
    if (!refArgs.length) throw fatal('--delete doesn\'t make sense without any refs');
    for (const r of refArgs) specs.push({ src: null, dst: r.startsWith('refs/') ? r : `refs/heads/${r}`, force: false, label: r });
  } else if (refArgs.length) {
    for (const r of refArgs) specs.push(parseRefspec(repo, r, forceAll || !!leaseFlag));
  } else if (a.has('--all')) {
    for (const b of repo.branches()) specs.push(parseRefspec(repo, b, forceAll || !!leaseFlag));
  } else if (a.has('--tags')) {
    // handled below
  } else {
    if (!branch) {
      throw fatal(
        'You are not currently on a branch.\nTo push the history leading to the current (detached HEAD)\nstate now, use\n\n    git push ' +
          remote +
          ' HEAD:<name-of-remote-branch>\n',
      );
    }
    const up = repo.upstreamOf(branch);
    if (!up && !setUpstream && repo.getConfig('push.autoSetupRemote') !== 'true') {
      throw new GitError(
        `fatal: The current branch ${branch} has no upstream branch.\n` +
          'To push the current branch and set the remote as upstream, use\n\n' +
          `    git push --set-upstream ${remote} ${branch}\n\n` +
          "To have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in 'git help config'.\n",
        128,
      );
    }
    const dstName = up && up.remote === remote ? up.branch : branch;
    specs.push({ src: branch, dst: `refs/heads/${dstName}`, force: forceAll || !!leaseFlag, label: `${branch} -> ${dstName}` });
  }
  if (a.has('--tags')) {
    for (const t of repo.tags()) specs.push({ src: `refs/tags/${t}`, dst: `refs/tags/${t}`, force: forceAll, label: `${t} -> ${t}` });
  }

  const progress: string[] = [];
  const remoteLines: string[] = [];
  const results: string[] = [];
  const upstreamLines: string[] = [];
  const hints: string[] = [];
  let failed = false;
  let sentObjects = 0;

  for (const s of specs) {
    const remoteOld = host.refs.get(s.dst);
    const shortDst = s.dst.replace(/^refs\/(heads|tags)\//, '');
    const isBranch = s.dst.startsWith('refs/heads/');
    const protection = isBranch ? host.protection.get(shortDst) : undefined;

    if (s.src === null) {
      if (!remoteOld) {
        results.push(` ! ${c.red('[remote rejected]')} ${shortDst} (remote ref does not exist)`);
        failed = true;
        continue;
      }
      if (protection) {
        remoteLines.push(`remote: error: GH006: Protected branch update failed for ${s.dst}.`, 'remote: error: Cannot delete this branch');
        results.push(` ! ${c.red('[remote rejected]')} ${shortDst} (protected branch hook declined)`);
        failed = true;
        continue;
      }
      if (!dry) {
        updateHostedRef(host, s.dst, null, false, ctx.world.user);
        repo.deleteRef(`refs/remotes/${remote}/${shortDst}`);
      }
      results.push(` - ${c.red('[deleted]')}         ${shortDst}`);
      ctx.world.emit({ type: 'push', remote, ref: s.dst, deleted: true, forced: false });
      continue;
    }

    const local = s.src.startsWith('refs/tags/') ? repo.getRef(s.src) : tryRevParse(repo, s.src) ?? (dwimRef(repo, s.src) ? repo.getRef(dwimRef(repo, s.src)!) : null);
    if (!local) {
      results.push(`error: src refspec ${s.src} does not match any`);
      failed = true;
      continue;
    }
    const localCommit = repo.objects.peel(local);
    if (remoteOld === local) {
      continue; // up to date
    }

    const isFF = !remoteOld || (repo.objects.has(remoteOld) && repo.isAncestor(remoteOld, localCommit));
    const tracking = repo.getRef(`refs/remotes/${remote}/${shortDst}`);

    if (leaseFlag && remoteOld && isBranch) {
      const m = /^--force-with-lease(?:=([^:]+)(?::(.+))?)?$/.exec(leaseFlag);
      const expect = m?.[2] ? tryRevParse(repo, m[2]) : tracking;
      if (expect !== remoteOld) {
        results.push(` ! ${c.red('[rejected]')}        ${s.label} (stale info)`);
        failed = true;
        continue;
      }
    }

    if (!isFF && !s.force) {
      const knownRemote = remoteOld && repo.objects.has(remoteOld);
      results.push(` ! ${c.red('[rejected]')}        ${s.label} (${knownRemote ? 'non-fast-forward' : 'fetch first'})`);
      hints.push(
        ...(knownRemote
          ? [
              'hint: Updates were rejected because the tip of your current branch is behind',
              'hint: its remote counterpart. If you want to integrate the remote changes,',
              "hint: use 'git pull' before pushing again.",
            ]
          : [
              'hint: Updates were rejected because the remote contains work that you do not',
              'hint: have locally. This is usually caused by another repository pushing to',
              "hint: the same ref. If you want to integrate the remote changes, use",
              "hint: 'git pull' before pushing again.",
            ]),
        "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
      );
      failed = true;
      ctx.world.emit({ type: 'push-rejected', remote, ref: s.dst, reason: knownRemote ? 'non-fast-forward' : 'fetch first' });
      continue;
    }

    if (protection) {
      if (!isFF && !protection.allowForcePush) {
        remoteLines.push(`remote: error: GH006: Protected branch update failed for ${s.dst}.`, 'remote: error: Cannot force-push to this branch');
        results.push(` ! ${c.red('[remote rejected]')} ${s.label} (protected branch hook declined)`);
        failed = true;
        ctx.world.emit({ type: 'push-rejected', remote, ref: s.dst, reason: 'protected' });
        continue;
      }
      if (protection.requirePullRequest) {
        remoteLines.push(`remote: error: GH006: Protected branch update failed for ${s.dst}.`, 'remote: error: Changes must be made through a pull request.');
        results.push(` ! ${c.red('[remote rejected]')} ${s.label} (protected branch hook declined)`);
        failed = true;
        ctx.world.emit({ type: 'push-rejected', remote, ref: s.dst, reason: 'protected' });
        continue;
      }
    }

    // Accepted.
    sentObjects += countObjects(repo.objects, [localCommit], (h) => host.objects.has(h));
    if (!dry) {
      host.objects.copyReachable(repo.objects, [local]);
      updateHostedRef(host, s.dst, local, !isFF, ctx.world.user);
      if (isBranch) {
        const tref = `refs/remotes/${remote}/${shortDst}`;
        const old = repo.getRef(tref);
        repo.setRefQuiet(tref, local);
        repo.appendReflog(tref, old ?? '0'.repeat(40), local, 'update by push');
      }
    }
    const isTag = s.dst.startsWith('refs/tags/');
    if (!remoteOld) {
      results.push(` * ${c.green(isTag ? '[new tag]' : '[new branch]')}      ${s.label}`);
      if (isBranch && shortDst !== host.defaultBranch && !host.pulls.some((p) => p.head === shortDst && p.state === 'open')) {
        remoteLines.push(
          'remote: ',
          `remote: Create a pull request for '${shortDst}' on GitHub by visiting:`,
          `remote:      ${host.webUrl}/pull/new/${shortDst}`,
          'remote: ',
        );
      }
    } else if (isFF) {
      results.push(`   ${shortHash(remoteOld)}..${shortHash(localCommit)}  ${s.label}`);
    } else {
      results.push(` + ${shortHash(remoteOld)}...${shortHash(localCommit)} ${s.label} (forced update)`);
    }
    ctx.world.emit({ type: 'push', remote, ref: s.dst, old: remoteOld ?? null, new: local, forced: !isFF, branch: shortDst });

    if (setUpstream && isBranch && s.src !== 'HEAD' && !dry) {
      const localBranch = s.src.replace(/^refs\/heads\//, '');
      if (repo.branchHash(localBranch)) {
        repo.setUpstream(localBranch, remote, shortDst);
        upstreamLines.push(`branch '${localBranch}' set up to track '${remote}/${shortDst}'.`);
      }
    } else if (!setUpstream && isBranch && !dry && !remoteOld && repo.getConfig('push.autoSetupRemote') === 'true' && s.src === branch) {
      repo.setUpstream(branch, remote, shortDst);
      upstreamLines.push(`branch '${branch}' set up to track '${remote}/${shortDst}'.`);
    }
  }

  if (sentObjects) {
    const n = sentObjects;
    const m = Math.max(1, Math.ceil(n * 0.6));
    progress.push(
      `Enumerating objects: ${n}, done.`,
      `Counting objects: 100% (${n}/${n}), done.`,
      'Delta compression using up to 8 threads',
      `Compressing objects: 100% (${m}/${m}), done.`,
      `Writing objects: 100% (${m}/${m}), ${(m * 0.11).toFixed(2)} KiB | ${(m * 0.11).toFixed(2)} MiB/s, done.`,
      `Total ${m} (delta ${Math.floor(m / 3)}), reused 0 (delta 0), pack-reused 0`,
    );
  }

  const srcErrors = results.filter((r) => r.startsWith('error: src refspec'));
  if (srcErrors.length && srcErrors.length === results.length) {
    throw new GitError(`${srcErrors.join('\n')}\nerror: failed to push some refs to '${displayUrl(url)}'`, 1);
  }
  if (!results.length) {
    print(ctx, 'Everything up-to-date');
    return 0;
  }
  print(ctx, ...progress, ...remoteLines, `To ${displayUrl(url)}`, ...results.filter((r) => !r.startsWith('error:')), ...upstreamLines);
  if (failed) {
    print(ctx, ...srcErrors, `error: failed to push some refs to '${displayUrl(url)}'`, ...hints);
    return 1;
  }
  return 0;
}

