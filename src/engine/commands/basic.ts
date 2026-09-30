import { c } from '../ansi';
import {
  ensureIdentity,
  filterBySpecs,
  pathspecs,
  print,
  repoRoot,
  requireRepo,
  toRepoPath,
  type GitContext,
} from '../context';
import {
  cleanMessage,
  commitSummary,
  commitTemplate,
  diffFileMaps,
  formatLongStatus,
  formatShortStatus,
} from '../format';
import { shortHash, subject, type Hash, type Signature } from '../objects';
import type { Repository } from '../repo';
import { revParseCommit } from '../revparse';
import { Args, failure, fatal, gitDate, GitError, matchPathspec } from '../util';

/* --------------------------------- init --------------------------------- */

export function cmdInit(ctx: GitContext, argv: string[]): number {
  const a = new Args(argv, ['-b', '--initial-branch']);
  const branch = a.value('-b', '--initial-branch') ?? ctx.world.globalConfig.get('init.defaultbranch') ?? 'main';
  let dir = ctx.dir;
  const name = a.rest[0];
  if (name) {
    if (dir) throw fatal('nested repositories are above your pay grade. Run `git init` from ~ or inside the folder.');
    dir = ctx.world.dirs.get(name) ?? ctx.world.createDir(name, false);
  }
  if (!dir) {
    throw fatal(
      "IT policy forbids turning your entire home directory into a git repository.\n(Yes, someone tried. It was Gary. That's why this is Gary's old machine.)",
    );
  }
  const path = `${ctx.world.homePath}/${dir.name}/.git/`;
  if (dir.initialized) {
    print(ctx, `Reinitialized existing Git repository in ${path}`);
    return 0;
  }
  dir.initialized = true;
  dir.head = { kind: 'branch', name: branch };
  print(ctx, `Initialized empty Git repository in ${path}`);
  return 0;
}

/* -------------------------------- config -------------------------------- */

export function cmdConfig(ctx: GitContext, argv: string[]): number {
  // Newer git (2.46+) also accepts `git config get|set|unset|list ...`.
  const sub = argv[0];
  if (sub === 'list') argv = ['--list', ...argv.slice(1)];
  else if (sub === 'get') argv = argv.slice(1);
  else if (sub === 'set') argv = argv.slice(1);
  else if (sub === 'unset') argv = ['--unset', ...argv.slice(1)];

  const a = new Args(argv);
  const global = a.has('--global');
  const repo = ctx.dir?.initialized ? ctx.dir : null;

  if (a.has('--list', '-l')) {
    for (const [k, v] of ctx.world.globalConfig) print(ctx, `${k}=${v}`);
    if (!global && repo) for (const [k, v] of repo.config) print(ctx, `${k}=${v}`);
    return 0;
  }

  const [key, ...valueParts] = a.rest;
  if (!key) {
    print(ctx, 'usage: git config [<options>]', '', 'Config file location', '    --global              use global config file', '    --local               use repository config file', '', 'Action', '    --get                 get value: name', '    --unset               remove a variable: name', '    -l, --list            list all');
    return 129;
  }
  if (!key.includes('.') || key.startsWith('.') || key.endsWith('.')) {
    throw failure(`error: key does not contain a section: ${key}`, 2);
  }
  const lower = key.replace(/^([^.]+)/, (s) => s.toLowerCase()).replace(/([^.]+)$/, (s) => s.toLowerCase());

  if (a.has('--unset')) {
    const ok = global ? ctx.world.globalConfig.delete(lower) : repo?.unsetConfig(lower);
    return ok ? 0 : 5;
  }

  if (!valueParts.length || a.has('--get')) {
    const v = global ? ctx.world.globalConfig.get(lower) : repo ? repo.getConfig(lower) : ctx.world.globalConfig.get(lower);
    if (v === undefined) return 1;
    print(ctx, v);
    return 0;
  }

  const value = valueParts.join(' ');
  if (global) ctx.world.globalConfig.set(lower, value);
  else {
    if (!repo) throw fatal('not in a git directory');
    repo.setConfig(lower, value);
  }
  ctx.world.emit({ type: 'config', key: lower, value, global });
  if (lower === 'core.editor' && /vi|emacs|code/.test(value)) {
    print(ctx, c.gray(`# (IT policy note: the only editor installed is nano. Your preference has been noted and ignored.)`));
  }
  return 0;
}

/* -------------------------------- status -------------------------------- */

export function cmdStatus(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv);
  if (a.has('-s', '--short', '--porcelain')) {
    print(ctx, ...formatShortStatus(repo, a.has('-b', '--branch')));
  } else {
    print(ctx, ...formatLongStatus(repo));
  }
  return 0;
}

/* ---------------------------------- add --------------------------------- */

export function stagePath(repo: Repository, p: string): void {
  const content = repo.worktree.get(p);
  repo.conflicts.delete(p);
  if (content === undefined) repo.index.delete(p);
  else repo.index.set(p, repo.objects.putBlob(content));
}

export function cmdAdd(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv);
  if (a.has('-p', '--patch', '-i', '--interactive')) {
    throw fatal("interactive add isn't available on this machine. Stage whole files (git add <file>) for now.");
  }
  const force = a.has('-f', '--force');
  const updateOnly = a.has('-u', '--update');
  const all = a.has('-A', '--all');
  const dryRun = a.has('-n', '--dry-run');
  const verbose = a.has('-v', '--verbose') || dryRun;
  let specArgs = [...a.rest, ...(a.afterDashDash ?? [])];

  if (!specArgs.length && !updateOnly && !all) {
    print(
      ctx,
      'Nothing specified, nothing added.',
      "hint: Maybe you wanted to say 'git add .'?",
      'hint: Turn this message off by running',
      'hint: "git config advice.addEmptyPathspec false"',
    );
    return 0;
  }
  if (!specArgs.length) specArgs = all ? ['/'] : ['/'];
  const specs = pathspecs(ctx, repo, specArgs);

  const tracked = new Set([...repo.index.keys(), ...repo.conflicts.keys()]);
  const candidates = updateOnly ? [...tracked] : [...new Set([...tracked, ...repo.worktree.keys()])];

  const ignoredHits: string[] = [];
  const toStage: string[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const matches = filterBySpecs(candidates, [spec]);
    if (!matches.length) {
      const ignoredMatch = [...repo.worktree.keys()].some((p) => matchPathspec(spec, p) && repo.isIgnored(p));
      if (ignoredMatch && !force) {
        ignoredHits.push(specArgs[i]);
        continue;
      }
      if (!updateOnly) throw fatal(`pathspec '${specArgs[i]}' did not match any files`);
    }
    for (const p of matches) {
      if (!tracked.has(p) && repo.isIgnored(p) && !force) {
        // Explicitly naming an ignored file is an error; sweeping it up via '.' is silently skipped.
        if (spec === p) ignoredHits.push(p);
        continue;
      }
      toStage.push(p);
    }
  }

  for (const p of [...new Set(toStage)].sort()) {
    const before = repo.index.get(p);
    const exists = repo.worktree.has(p);
    const changed = repo.conflicts.has(p) || before !== (exists ? repo.worktreeHash(p) : undefined);
    if (!dryRun) stagePath(repo, p);
    if (verbose && changed) print(ctx, exists ? `add '${p}'` : `remove '${p}'`);
  }
  ctx.world.emit({ type: 'add', paths: toStage });

  if (ignoredHits.length) {
    print(
      ctx,
      'The following paths are ignored by one of your .gitignore files:',
      ...ignoredHits,
      'hint: Use -f if you really want to add them.',
      'hint: Turn this message off by running',
      'hint: "git config advice.addIgnoredFile false"',
    );
    return 1;
  }
  return 0;
}

/* ---------------------------------- rm ---------------------------------- */

export function cmdRm(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv);
  const cached = a.has('--cached');
  const recursive = a.has('-r');
  const force = a.has('-f', '--force');
  const quiet = a.has('-q', '--quiet');
  const specArgs = [...a.rest, ...(a.afterDashDash ?? [])];
  if (!specArgs.length) throw fatal('No pathspec was given. Which files should I remove?');
  const specs = pathspecs(ctx, repo, specArgs);
  const tracked = [...new Set([...repo.index.keys(), ...repo.conflicts.keys()])];
  const headF = repo.headFiles();

  const targets: string[] = [];
  specs.forEach((spec, i) => {
    const matches = filterBySpecs(tracked, [spec]);
    if (!matches.length) throw fatal(`pathspec '${specArgs[i]}' did not match any files`);
    if (!recursive && matches.some((m) => m !== spec) && !matches.includes(spec)) {
      throw fatal(`not removing '${specArgs[i]}' recursively without -r`);
    }
    targets.push(...matches);
  });

  if (!force && !cached) {
    const staged = targets.filter((p) => repo.index.has(p) && repo.index.get(p) !== headF.get(p) && headF.has(p));
    const modified = targets.filter((p) => repo.index.has(p) && repo.worktree.has(p) && repo.worktreeHash(p) !== repo.index.get(p));
    if (staged.length) {
      throw failure(
        `error: the following file${staged.length > 1 ? 's have' : ' has'} changes staged in the index:\n${staged
          .map((p) => `    ${p}`)
          .join('\n')}\n(use --cached to keep the file, or -f to force removal)`,
      );
    }
    if (modified.length) {
      throw failure(
        `error: the following file${modified.length > 1 ? 's have' : ' has'} local modifications:\n${modified
          .map((p) => `    ${p}`)
          .join('\n')}\n(use --cached to keep the file, or -f to force removal)`,
      );
    }
  }

  for (const p of [...new Set(targets)]) {
    repo.index.delete(p);
    repo.conflicts.delete(p);
    if (!cached) repo.worktree.delete(p);
    if (!quiet) print(ctx, `rm '${p}'`);
  }
  ctx.world.emit({ type: 'rm', paths: targets, cached });
  return 0;
}

/* ---------------------------------- mv ---------------------------------- */

export function cmdMv(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv);
  if (a.rest.length !== 2) throw fatal('usage: git mv <source> <destination>');
  const src = toRepoPath(ctx, repo, a.rest[0]);
  let dst = toRepoPath(ctx, repo, a.rest[1]);
  const isDir = (p: string) => [...repo.worktree.keys()].some((k) => k.startsWith(p + '/')) || repo.emptyDirs.has(p);
  if (isDir(dst)) dst = `${dst}/${src.split('/').pop()}`;
  const loc = `source=${a.rest[0]}, destination=${a.rest[1]}`;

  const moving = repo.index.has(src)
    ? [[src, dst]]
    : [...repo.index.keys()].filter((p) => p.startsWith(src + '/')).map((p) => [p, dst + p.slice(src.length)]);
  if (!repo.worktree.has(src) && !moving.length) throw fatal(`bad source, ${loc}`);
  if (!moving.length) throw fatal(`not under version control, ${loc}`);
  if (repo.worktree.has(dst) && !a.has('-f', '--force')) throw fatal(`destination exists, ${loc}`);

  for (const [from, to] of moving) {
    const content = repo.worktree.get(from);
    const h = repo.index.get(from)!;
    repo.index.delete(from);
    repo.index.set(to, h);
    if (content !== undefined) {
      repo.worktree.delete(from);
      repo.worktree.set(to, content);
    }
  }
  return 0;
}

/* -------------------------------- commit -------------------------------- */

export interface CommitOptions {
  message?: string;
  amend?: boolean;
  author?: Signature;
  allowEmpty?: boolean;
  /** For printing: override the reflog verb ("commit", "cherry-pick", ...). */
  reflogVerb?: string;
  quiet?: boolean;
  /** Show the author date line in the summary (amend/cherry-pick do this). */
  showDate?: boolean;
}

/** Record the index as a new commit on HEAD. Shared by commit, merge, cherry-pick, revert, rebase. */
export function recordCommit(ctx: GitContext, repo: Repository, parents: Hash[], message: string, opts: CommitOptions = {}): Hash {
  const tree = repo.writeTree(repo.index);
  const committer = repo.signature();
  const author = opts.author ?? { ...committer };
  const h = repo.makeCommit(tree, parents, message, { author, committer });
  const isRoot = parents.length === 0;
  let verb = opts.reflogVerb ?? 'commit';
  if (!opts.reflogVerb) {
    if (isRoot) verb = 'commit (initial)';
    else if (opts.amend) verb = 'commit (amend)';
    else if (parents.length > 1) verb = 'commit (merge)';
  }
  repo.moveHead(h, `${verb}: ${subject(message)}`);

  if (!opts.quiet) {
    const where = repo.currentBranch() ?? 'detached HEAD';
    print(ctx, `[${where}${isRoot ? ' (root-commit)' : ''} ${shortHash(h)}] ${subject(message)}`);
    if (opts.showDate || opts.amend) print(ctx, ` Date: ${gitDate(author.time)}`);
    if (parents.length <= 1) {
      const from = parents.length ? repo.commitFiles(parents[0]) : new Map();
      print(ctx, ...commitSummary(repo, diffFileMaps(from, repo.commitFiles(h))));
    }
  }
  ctx.world.emit({ type: 'commit', hash: h, message, branch: repo.currentBranch(), amend: !!opts.amend });
  return h;
}

export function parseAuthor(s: string): Signature | null {
  const m = /^\s*(.+?)\s*<([^>]+)>\s*$/.exec(s);
  return m ? { name: m[1], email: m[2], time: 0 } : null;
}

export async function cmdCommit(ctx: GitContext, argv: string[]): Promise<number> {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['-m', '--message', '-F', '--file', '--author', '-C', '--reuse-message', '--fixup']);
  const messages = a.values('-m', '--message');
  const amend = a.has('--amend');
  const noEdit = a.has('--no-edit');
  const allowEmpty = a.has('--allow-empty');
  const all = a.has('-a', '--all');
  const specArgs = [...a.rest, ...(a.afterDashDash ?? [])];

  if (a.value('-F', '--file')) {
    const p = toRepoPath(ctx, repo, a.value('-F', '--file')!);
    const content = repo.worktree.get(p);
    if (content === undefined) throw fatal(`could not read log file '${a.value('-F', '--file')}': No such file or directory`);
    messages.push(content);
  }

  if (repo.conflicts.size) {
    throw new GitError(
      'error: Committing is not possible because you have unmerged files.\n' +
        'hint: Fix them up in the work tree, and then use \'git add/rm <file>\'\n' +
        'hint: as appropriate to mark resolution and make a commit.\n' +
        'fatal: Exiting because of an unresolved conflict.\n' +
        [...repo.conflicts.keys()].sort().map((p) => `U\t${p}`).join('\n'),
      128,
    );
  }
  ensureIdentity(ctx, repo);

  const head = repo.headHash();
  if (amend && !head) throw fatal('You have nothing to amend.');
  if (amend && repo.op?.kind === 'merge') throw fatal('You are in the middle of a merge -- cannot amend.');

  if (all) {
    for (const p of repo.index.keys()) stagePath(repo, p);
  }
  if (specArgs.length) {
    // `git commit <paths>`: stage exactly those tracked paths from the worktree.
    const specs = pathspecs(ctx, repo, specArgs);
    const matched = filterBySpecs([...repo.index.keys()], specs);
    if (!matched.length) throw failure(`error: pathspec '${specArgs[0]}' did not match any file(s) known to git`);
    for (const p of matched) stagePath(repo, p);
  }

  const op = repo.op;
  let parents: Hash[];
  if (amend) parents = repo.parents(head!);
  else if (op?.kind === 'merge' && !op.squash) parents = [head!, op.mergeHead];
  else parents = head ? [head] : [];

  const tree = repo.writeTree(repo.index);
  const compareTo = amend ? (parents.length ? repo.objects.commit(parents[0]).tree : null) : head ? repo.objects.commit(head).tree : null;
  const emptyTree = repo.writeTree(new Map());
  const unchanged = compareTo ? tree === compareTo : tree === emptyTree;
  if (unchanged && !allowEmpty && !amend && !(op?.kind === 'merge' && !op.squash)) {
    if (op?.kind === 'cherry-pick') {
      print(
        ctx,
        'The previous cherry-pick is now empty, possibly due to conflict resolution.',
        'If you wish to commit it anyway, use:',
        '',
        '    git commit --allow-empty',
        '',
        'Otherwise, please use \'git cherry-pick --skip\'',
      );
      return 1;
    }
    print(ctx, ...formatLongStatus(repo));
    return 1;
  }

  // Work out the message.
  let message: string;
  let defaultMsg = '';
  if (amend) defaultMsg = repo.objects.commit(head!).message;
  else if (op?.kind === 'merge') defaultMsg = op.message;
  else if (op?.kind === 'cherry-pick' || op?.kind === 'revert') defaultMsg = op.message;
  else if (op?.kind === 'rebase' && op.current && op.stopReason === 'conflict') {
    defaultMsg = repo.objects.commit(op.current.commit).message;
  }

  if (messages.length) {
    message = messages.join('\n\n');
  } else if (noEdit && defaultMsg) {
    message = defaultMsg;
  } else {
    const edited = await ctx.editor('.git/COMMIT_EDITMSG', commitTemplate(repo, defaultMsg ? defaultMsg + '\n' : ''));
    if (edited === null) {
      throw failure('Aborting commit due to empty commit message.');
    }
    message = cleanMessage(edited);
  }
  message = message.replace(/\n+$/, '');
  if (!message.trim()) throw failure('Aborting commit due to empty commit message.');

  let author: Signature | undefined;
  if (a.value('--author')) {
    const p = parseAuthor(a.value('--author')!);
    if (!p) throw fatal(`--author '${a.value('--author')}' is not 'Name <email>' and matches no existing author`);
    author = { ...p, time: ctx.world.clock.stamp() };
  } else if (amend && !a.has('--reset-author')) {
    author = repo.objects.commit(head!).author;
  } else if (op && (op.kind === 'cherry-pick') && op.author) {
    author = op.author;
  } else if (op?.kind === 'rebase' && op.current && op.stopReason === 'conflict') {
    author = repo.objects.commit(op.current.commit).author;
  }

  const isRebaseEdit = op?.kind === 'rebase';
  recordCommit(ctx, repo, parents, message, {
    amend,
    author,
    quiet: a.has('-q', '--quiet'),
    showDate: amend,
  });
  if (op && !isRebaseEdit) {
    // Concluding a merge/cherry-pick/revert.
    repo.special.delete('MERGE_HEAD');
    repo.special.delete('CHERRY_PICK_HEAD');
    repo.special.delete('REVERT_HEAD');
    if (op.kind === 'merge' || ((op.kind === 'cherry-pick' || op.kind === 'revert') && !op.todo.length)) {
      repo.op = null;
    } else if (op.kind === 'cherry-pick' || op.kind === 'revert') {
      op.committed = true;
    }
  }
  return 0;
}

/* -------------------------------- restore ------------------------------- */

export function cmdRestore(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['-s', '--source']);
  const staged = a.has('-S', '--staged');
  const worktree = a.has('-W', '--worktree') || !staged;
  const ours = a.has('--ours');
  const theirs = a.has('--theirs');
  const specArgs = [...a.rest, ...(a.afterDashDash ?? [])];
  if (!specArgs.length) throw fatal('you must specify path(s) to restore');
  const specs = pathspecs(ctx, repo, specArgs);

  const sourceSpec = a.value('-s', '--source');
  let source: Map<string, Hash>;
  if (sourceSpec) source = repo.commitFiles(revParseCommit(repo, sourceSpec));
  else if (staged) source = repo.headFiles();
  else source = repo.index;

  // Paths git "knows" about: anything in the source, the index, or mid-conflict.
  const known = new Set([...source.keys(), ...repo.index.keys(), ...repo.conflicts.keys()]);

  for (let i = 0; i < specs.length; i++) {
    const matches = filterBySpecs(known, [specs[i]]);
    if (!matches.length) throw failure(`error: pathspec '${specArgs[i]}' did not match any file(s) known to git`);
    for (const p of matches) {
      const conflict = repo.conflicts.get(p);
      if (conflict && worktree && !staged && !sourceSpec) {
        if (ours || theirs) {
          const h = ours ? conflict.ours : conflict.theirs;
          if (h === undefined) throw failure(`error: path '${p}' does not have ${ours ? 'our' : 'their'} version`);
          repo.worktree.set(p, repo.blob(h));
          continue;
        }
        throw failure(`error: path '${p}' is unmerged`);
      }
      const h = source.get(p);
      if (staged) {
        repo.conflicts.delete(p);
        if (h === undefined) repo.index.delete(p);
        else repo.index.set(p, h);
      }
      if (worktree) {
        if (h === undefined) repo.worktree.delete(p);
        else repo.worktree.set(p, repo.blob(h));
      }
    }
  }
  ctx.world.emit({ type: 'restore', paths: specs, staged, worktree });
  return 0;
}

/* --------------------------------- clean -------------------------------- */

export function cmdClean(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv);
  const dry = a.has('-n', '--dry-run');
  const force = a.has('-f', '--force');
  const dirs = a.has('-d');
  const includeIgnored = a.has('-x');
  if (!dry && !force) {
    throw fatal('clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean');
  }
  if (a.has('-i', '--interactive')) throw fatal('interactive clean is not available on this machine');
  const specArgs = [...a.rest, ...(a.afterDashDash ?? [])];
  const specs = specArgs.length ? pathspecs(ctx, repo, specArgs) : [ctx.cwd];

  const untracked = [...repo.worktree.keys()].filter((p) => !repo.isTracked(p) && (includeIgnored || !repo.isIgnored(p)));
  const shown = new Set<string>();
  const remove: string[] = [];
  for (const p of untracked.sort()) {
    if (!specs.some((s) => matchPathspec(s, p))) continue;
    // Without -d, files inside wholly-untracked directories are left alone.
    const segs = p.split('/');
    let dirEntry: string | null = null;
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/') + '/';
      if (![...repo.index.keys()].some((t) => t.startsWith(d))) {
        dirEntry = d;
        break;
      }
    }
    if (dirEntry && !dirs) continue;
    shown.add(dirEntry ?? p);
    remove.push(p);
  }
  for (const s of shown) print(ctx, `${dry ? 'Would remove' : 'Removing'} ${s}`);
  if (!dry) for (const p of remove) repo.worktree.delete(p);
  if (!dry) ctx.world.emit({ type: 'clean', paths: remove });
  return 0;
}

export function repoDisplayPath(ctx: GitContext, repo: Repository): string {
  return repoRoot(ctx, repo);
}
