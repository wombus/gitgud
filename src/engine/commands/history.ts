import { c } from '../ansi';
import { filterBySpecs, pathspecs, print, requireRepo, toRepoPath, type GitContext } from '../context';
import { myersDiff, splitLines } from '../diff';
import {
  commitHeader,
  decorationSuffix,
  decorations,
  diffFileMaps,
  formatPatch,
  formatStat,
  onelineCommit,
  type FileDiff,
} from '../format';
import { GraphRenderer, zipGraph } from '../graph';
import { shortHash, subject, type FileMap, type Hash } from '../objects';
import type { Repository } from '../repo';
import { dwimRef, parseRevRange, revParse, revParseCommit, tryRevParse } from '../revparse';
import { Args, fatal, gitDate, isoDate, matchPathspec, relativeTime } from '../util';

/* ------------------------------------------------------------------------- */
/* Revision walking                                                           */
/* ------------------------------------------------------------------------- */

interface WalkOptions {
  include: Hash[];
  exclude: Hash[];
  firstParent?: boolean;
  topo?: boolean;
}

/** Walk history newest-first (by commit date), like git's default revision walk. */
export function walk(repo: Repository, o: WalkOptions): Hash[] {
  const excluded = new Set<Hash>();
  if (o.exclude.length) {
    const stack = [...o.exclude];
    while (stack.length) {
      const h = stack.pop()!;
      if (excluded.has(h)) continue;
      excluded.add(h);
      stack.push(...(o.firstParent ? repo.parents(h).slice(0, 1) : repo.parents(h)));
    }
  }
  const time = (h: Hash) => repo.objects.commit(h).committer.time;
  const seen = new Set<Hash>();
  const queue: Hash[] = [];
  const out: Hash[] = [];
  const push = (h: Hash) => {
    if (seen.has(h) || excluded.has(h)) return;
    seen.add(h);
    queue.push(h);
  };
  for (const h of o.include) push(h);
  while (queue.length) {
    // Pick the newest commit in the queue (stable for ties).
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (time(queue[i]) > time(queue[best])) best = i;
    const h = queue.splice(best, 1)[0];
    out.push(h);
    const ps = repo.parents(h);
    for (const p of o.firstParent ? ps.slice(0, 1) : ps) push(p);
  }
  return o.topo ? topoSort(repo, out, o.firstParent) : out;
}

/** Children before parents, keeping lines of history together (git --topo-order). */
function topoSort(repo: Repository, commits: Hash[], firstParent?: boolean): Hash[] {
  const set = new Set(commits);
  const indeg = new Map<Hash, number>();
  const parentsIn = (h: Hash) => (firstParent ? repo.parents(h).slice(0, 1) : repo.parents(h)).filter((p) => set.has(p));
  for (const h of commits) indeg.set(h, 0);
  for (const h of commits) for (const p of parentsIn(h)) indeg.set(p, indeg.get(p)! + 1);
  // Tips in date order; the newest should be processed first, so push oldest first.
  const stack = commits.filter((h) => indeg.get(h) === 0).reverse();
  const out: Hash[] = [];
  while (stack.length) {
    const h = stack.pop()!;
    out.push(h);
    for (const p of parentsIn(h)) {
      const d = indeg.get(p)! - 1;
      indeg.set(p, d);
      if (d === 0) stack.push(p);
    }
  }
  return out;
}

/** Does commit h change any path matching specs (relative to its parents)? */
function touches(repo: Repository, h: Hash, specs: string[]): boolean {
  const files = repo.commitFiles(h);
  const ps = repo.parents(h);
  const differs = (from: FileMap) => {
    for (const p of new Set([...from.keys(), ...files.keys()])) {
      if (!specs.some((s) => matchPathspec(s, p))) continue;
      if (from.get(p) !== files.get(p)) return true;
    }
    return false;
  };
  if (!ps.length) return differs(new Map());
  // A merge is interesting only if it differs from *every* parent on these paths.
  return ps.every((p) => differs(repo.commitFiles(p)));
}

/* ------------------------------------------------------------------------- */
/* --format placeholders                                                      */
/* ------------------------------------------------------------------------- */

function formatPlaceholders(repo: Repository, h: Hash, fmt: string): string {
  const co = repo.objects.commit(h);
  const now = repo.world.clock.now();
  const [subj, ...bodyLines] = co.message.split('\n');
  const body = bodyLines.join('\n').replace(/^\n+/, '');
  const colors: Record<string, string> = {
    red: '31',
    green: '32',
    yellow: '33',
    blue: '34',
    magenta: '35',
    cyan: '36',
    white: '37',
    reset: '0',
    bold: '1',
    dim: '2',
  };
  return fmt.replace(/%(C\((\w+(?: \w+)*)\)|Cred|Cgreen|Cblue|Creset|[Hhs]|an|ae|ad|ar|ai|cn|ce|cr|cd|d|D|n|b|B|P|p|T|t|%)/g, (m, tok, cname) => {
    if (cname) {
      const codes = String(cname)
        .split(' ')
        .map((w: string) => colors[w] ?? '')
        .filter(Boolean)
        .join(';');
      return codes ? `\x1b[${codes}m` : '';
    }
    switch (tok) {
      case 'Cred':
        return '\x1b[31m';
      case 'Cgreen':
        return '\x1b[32m';
      case 'Cblue':
        return '\x1b[34m';
      case 'Creset':
        return '\x1b[0m';
      case 'H':
        return h;
      case 'h':
        return shortHash(h);
      case 's':
        return subj;
      case 'b':
        return body;
      case 'B':
        return co.message;
      case 'an':
        return co.author.name;
      case 'ae':
        return co.author.email;
      case 'ad':
        return gitDate(co.author.time);
      case 'ai':
        return isoDate(co.author.time);
      case 'ar':
        return relativeTime(co.author.time, now);
      case 'cn':
        return co.committer.name;
      case 'ce':
        return co.committer.email;
      case 'cd':
        return gitDate(co.committer.time);
      case 'cr':
        return relativeTime(co.committer.time, now);
      case 'd':
        return decorationSuffix(repo, h);
      case 'D':
        return decorations(repo, h).join(', ');
      case 'n':
        return '\n';
      case 'P':
        return co.parents.join(' ');
      case 'p':
        return co.parents.map(shortHash).join(' ');
      case 'T':
        return co.tree;
      case 't':
        return shortHash(co.tree);
      case '%':
        return '%';
    }
    return m;
  });
}

/* ------------------------------------------------------------------------- */
/* git log                                                                    */
/* ------------------------------------------------------------------------- */

function commitDiffs(repo: Repository, h: Hash, specs: string[] | null): FileDiff[] {
  const ps = repo.parents(h);
  const from = ps.length ? repo.commitFiles(ps[0]) : new Map();
  let diffs = diffFileMaps(from, repo.commitFiles(h));
  if (specs) diffs = diffs.filter((d) => specs.some((s) => matchPathspec(s, d.path) || (d.oldPath && matchPathspec(s, d.oldPath))));
  return diffs;
}

export function cmdLog(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['-n', '--max-count', '--author', '--grep', '--format', '--pretty', '--since', '--until']);

  let max = Infinity;
  const n = a.value('-n', '--max-count');
  if (n) max = parseInt(n, 10);
  const revArgs: string[] = [];
  const pathArgs: string[] = [...(a.afterDashDash ?? [])];
  for (const r of a.rest) {
    if (/^-\d+$/.test(r)) {
      max = parseInt(r.slice(1), 10);
      continue;
    }
    if (a.afterDashDash === null && !tryRevParse(repo, r.replace(/^\^/, '').split('..')[0] || 'HEAD') && !r.includes('..')) {
      // Not a revision: treat as a path if it exists, like git does.
      const p = toRepoPath(ctx, repo, r);
      const exists = repo.worktree.has(p) || repo.index.has(p) || [...repo.index.keys()].some((k) => k.startsWith(p + '/'));
      if (exists) {
        pathArgs.push(r);
        continue;
      }
    }
    revArgs.push(r);
  }

  const graph = a.has('--graph');
  const all = a.has('--all');
  let format = a.value('--format', '--pretty') ?? (a.has('--oneline') ? 'oneline-abbrev' : 'medium');
  if (a.has('--oneline')) format = 'oneline-abbrev';
  const decorate = !a.has('--no-decorate');
  const reverse = a.has('--reverse');
  const firstParent = a.has('--first-parent');

  const range = parseRevRange(repo, revArgs);
  const include = [...range.include];
  if (all) {
    for (const [, h] of repo.refs) include.push(repo.objects.peel(h));
    const hh = repo.headHash();
    if (hh) include.push(hh);
  } else {
    if (a.has('--branches')) for (const b of repo.branches()) include.push(repo.branchHash(b)!);
    if (a.has('--remotes')) for (const r of repo.remoteBranches()) include.push(repo.getRef(`refs/remotes/${r}`)!);
    if (a.has('--tags')) for (const t of repo.tags()) include.push(repo.objects.peel(repo.getRef(`refs/tags/${t}`)!));
  }
  if (!include.length) {
    if (range.exclude.length) {
      const hh = repo.headHash();
      if (hh) include.push(hh);
    } else {
      const hh = repo.headHash();
      if (!hh) {
        const b = repo.currentBranch() ?? 'HEAD';
        throw fatal(`your current branch '${b}' does not have any commits yet`);
      }
      include.push(hh);
    }
  }

  let commits = walk(repo, { include, exclude: range.exclude, firstParent, topo: graph });

  const specs = pathArgs.length ? pathspecs(ctx, repo, pathArgs) : null;
  if (specs) commits = commits.filter((h) => touches(repo, h, specs));
  const author = a.value('--author');
  if (author) commits = commits.filter((h) => {
    const co = repo.objects.commit(h);
    return `${co.author.name} <${co.author.email}>`.toLowerCase().includes(author.toLowerCase());
  });
  const grep = a.value('--grep');
  if (grep) {
    const flags = a.has('-i', '--regexp-ignore-case') ? 'i' : '';
    let re: RegExp;
    try {
      re = new RegExp(grep, flags);
    } catch {
      re = new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    }
    commits = commits.filter((h) => re.test(repo.objects.commit(h).message));
  }
  if (a.has('--merges')) commits = commits.filter((h) => repo.parents(h).length > 1);
  if (a.has('--no-merges')) commits = commits.filter((h) => repo.parents(h).length <= 1);
  commits = commits.slice(0, max);
  if (reverse) commits.reverse();

  const shown = new Set(commits);
  const renderer = graph
    ? new GraphRenderer((h) => (firstParent ? repo.parents(h).slice(0, 1) : repo.parents(h)).filter((p) => shown.has(p)))
    : null;
  const stat = a.has('--stat');
  const patch = a.has('-p', '--patch', '-u');
  const nameOnly = a.has('--name-only');
  const nameStatus = a.has('--name-status');

  const lines: string[] = [];
  commits.forEach((h, idx) => {
    let text: string[];
    const co = repo.objects.commit(h);
    if (format === 'oneline-abbrev') text = [onelineCommit(repo, h, decorate)];
    else if (format === 'oneline') text = [`${c.yellow(h)}${decorate ? decorationSuffix(repo, h) : ''} ${subject(co.message)}`];
    else if (format === 'short') {
      text = [c.yellow(`commit ${h}`) + (decorate ? decorationSuffix(repo, h) : ''), `Author: ${co.author.name} <${co.author.email}>`, '', `    ${subject(co.message)}`];
    } else if (format === 'medium' || format === 'full' || format === 'fuller') {
      text = commitHeader(repo, h, { decorate });
    } else {
      const f = format.replace(/^(format|tformat):/, '');
      text = formatPlaceholders(repo, h, f).split('\n');
    }
    const multiLine = format === 'medium' || format === 'short' || format === 'full' || format === 'fuller';
    const extra: string[] = [];
    if (stat || patch || nameOnly || nameStatus) {
      const diffs = commitDiffs(repo, h, specs);
      if (nameOnly) extra.push(...diffs.map((d) => d.path));
      if (nameStatus) extra.push(...diffs.map((d) => `${d.status}\t${d.oldPath ? `${d.oldPath}\t` : ''}${d.path}`));
      if (stat) extra.push(...formatStat(repo, diffs));
      if (patch && repo.parents(h).length <= 1) {
        if (stat) extra.push('');
        extra.push(...formatPatch(repo, diffs));
      }
      if (multiLine && extra.length) extra.unshift('');
    }
    text.push(...extra);
    const needsGap = multiLine && idx < commits.length - 1;
    if (renderer) {
      const step = renderer.next(h);
      if (needsGap) text.push('');
      lines.push(...zipGraph(step, text));
    } else {
      lines.push(...text);
      if (needsGap) lines.push('');
    }
  });
  print(ctx, ...lines);
  return 0;
}

/* ------------------------------------------------------------------------- */
/* git shortlog                                                               */
/* ------------------------------------------------------------------------- */

export function cmdShortlog(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv);
  const range = parseRevRange(repo, a.rest);
  const include = range.include.length ? range.include : [repo.headHash()!].filter(Boolean);
  if (a.has('--all')) for (const b of repo.branches()) include.push(repo.branchHash(b)!);
  const commits = walk(repo, { include, exclude: range.exclude });
  const by = new Map<string, string[]>();
  for (const h of commits) {
    const co = repo.objects.commit(h);
    const key = a.has('-e', '--email') ? `${co.author.name} <${co.author.email}>` : co.author.name;
    const list = by.get(key) ?? [];
    list.push(subject(co.message));
    by.set(key, list);
  }
  let entries = [...by.entries()];
  if (a.has('-n', '--numbered')) entries.sort((x, y) => y[1].length - x[1].length || (x[0] < y[0] ? -1 : 1));
  else entries.sort((x, y) => (x[0] < y[0] ? -1 : 1));
  for (const [who, msgs] of entries) {
    if (a.has('-s', '--summary')) print(ctx, `${String(msgs.length).padStart(6)}\t${who}`);
    else {
      print(ctx, `${who} (${msgs.length}):`);
      for (const m of msgs.reverse()) print(ctx, `      ${m}`);
      print(ctx, '');
    }
  }
  return 0;
}

/* ------------------------------------------------------------------------- */
/* git show                                                                   */
/* ------------------------------------------------------------------------- */

export function cmdShow(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['--format', '--pretty']);
  const revs = a.rest.length ? a.rest : ['HEAD'];
  const lines: string[] = [];
  for (const spec of revs) {
    // `rev:path` shows a file as of that revision.
    const colon = /^([^:]*):(.+)$/.exec(spec);
    if (colon) {
      const [, rev, rawPath] = colon;
      const path = rawPath.startsWith('./') ? toRepoPath(ctx, repo, rawPath) : rawPath;
      let files: FileMap;
      let label = rev;
      if (rev === '') {
        files = repo.index;
        label = 'the index';
      } else files = repo.commitFiles(revParseCommit(repo, rev));
      const h = files.get(path);
      if (h === undefined) {
        throw fatal(rev === '' ? `path '${path}' does not exist (neither on disk nor in the index)` : `path '${path}' does not exist in '${label}'`);
      }
      lines.push(...splitLines(repo.blob(h)));
      continue;
    }
    const raw = revParseRaw(repo, spec);
    const obj = repo.objects.get(raw);
    if (obj?.type === 'tag') {
      lines.push(c.yellow(`tag ${obj.tag}`), `Tagger: ${obj.tagger.name} <${obj.tagger.email}>`, `Date:   ${gitDate(obj.tagger.time)}`, '', ...obj.message.replace(/\n+$/, '').split('\n'), '');
    }
    const h = revParseCommit(repo, spec);
    const co = repo.objects.commit(h);
    const fmt = a.value('--format', '--pretty');
    if (a.has('--oneline')) lines.push(onelineCommit(repo, h));
    else if (fmt) lines.push(...formatPlaceholders(repo, h, fmt.replace(/^(format|tformat):/, '')).split('\n'));
    else lines.push(...commitHeader(repo, h));
    if (a.has('-s', '--no-patch')) continue;
    const diffs = co.parents.length > 1 ? [] : commitDiffs(repo, h, null);
    if (a.has('--name-only')) {
      lines.push(...diffs.map((d) => d.path));
    } else if (a.has('--name-status')) {
      lines.push(...diffs.map((d) => `${d.status}\t${d.path}`));
    } else if (a.has('--stat')) {
      if (diffs.length) lines.push('', ...formatStat(repo, diffs));
    } else if (diffs.length) {
      if (!a.has('--oneline') && !fmt) lines.push('');
      lines.push(...formatPatch(repo, diffs));
    }
  }
  print(ctx, ...lines);
  return 0;
}

function revParseRaw(repo: Repository, spec: string): Hash {
  // Like revParse, but without peeling tags (so `git show v1.0` can show the tag object).
  const ref = dwimRef(repo, spec);
  if (ref) return repo.getRef(ref)!;
  return revParse(repo, spec);
}

/* ------------------------------------------------------------------------- */
/* git diff                                                                   */
/* ------------------------------------------------------------------------- */

export function cmdDiff(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv);
  const staged = a.has('--staged', '--cached');
  const revs: string[] = [];
  const pathArgs: string[] = [...(a.afterDashDash ?? [])];
  for (const r of a.rest) {
    const isRange = r.includes('..');
    const isRev = isRange || tryRevParse(repo, r) !== null;
    if (a.afterDashDash === null && !isRev) {
      const p = toRepoPath(ctx, repo, r);
      if (repo.worktree.has(p) || repo.index.has(p) || [...repo.index.keys()].some((k) => k.startsWith(p + '/'))) {
        pathArgs.push(r);
        continue;
      }
      revParse(repo, r); // throws the "unknown revision" error
    }
    revs.push(r);
  }
  const specs = pathArgs.length ? pathspecs(ctx, repo, pathArgs) : null;

  const worktreeSnapshot = (): FileMap => {
    const m: FileMap = new Map();
    for (const p of new Set([...repo.index.keys(), ...repo.conflicts.keys()])) {
      const content = repo.worktree.get(p);
      if (content !== undefined) m.set(p, repo.objects.putBlob(content));
    }
    return m;
  };

  let from: FileMap;
  let to: FileMap;
  if (revs.length === 1 && revs[0].includes('...')) {
    const [l, r] = revs[0].split('...');
    const lh = revParseCommit(repo, l || 'HEAD');
    const rh = revParseCommit(repo, r || 'HEAD');
    const base = repo.mergeBase(lh, rh);
    from = base ? repo.commitFiles(base) : new Map();
    to = repo.commitFiles(rh);
  } else if (revs.length === 1 && revs[0].includes('..')) {
    const [l, r] = revs[0].split('..');
    from = repo.commitFiles(revParseCommit(repo, l || 'HEAD'));
    to = repo.commitFiles(revParseCommit(repo, r || 'HEAD'));
  } else if (revs.length === 2) {
    from = repo.commitFiles(revParseCommit(repo, revs[0]));
    to = repo.commitFiles(revParseCommit(repo, revs[1]));
  } else if (revs.length === 1) {
    from = repo.commitFiles(revParseCommit(repo, revs[0]));
    to = staged ? new Map(repo.index) : worktreeSnapshot();
  } else if (staged) {
    from = repo.headFiles();
    to = new Map(repo.index);
  } else {
    from = new Map(repo.index);
    // Unmerged paths: compare "our" version with the conflicted worktree file.
    for (const [p, e] of repo.conflicts) if (e.ours) from.set(p, e.ours);
    to = worktreeSnapshot();
  }

  let diffs = diffFileMaps(from, to, { renames: revs.length > 0 || staged });
  if (specs) diffs = diffs.filter((d) => specs.some((s) => matchPathspec(s, d.path)));

  if (a.has('--name-only')) print(ctx, ...diffs.map((d) => d.path));
  else if (a.has('--name-status')) print(ctx, ...diffs.map((d) => `${d.status}\t${d.path}`));
  else if (a.has('--stat')) print(ctx, ...formatStat(repo, diffs));
  else if (a.has('--quiet', '--exit-code')) return diffs.length ? 1 : 0;
  else {
    if (!staged && !revs.length) {
      for (const p of [...repo.conflicts.keys()].sort()) {
        if (!specs || specs.some((s) => matchPathspec(s, p))) print(ctx, c.bold(`* Unmerged path ${p}`));
      }
    }
    print(ctx, ...formatPatch(repo, diffs));
  }
  return 0;
}

/* ------------------------------------------------------------------------- */
/* git reflog                                                                 */
/* ------------------------------------------------------------------------- */

export function cmdReflog(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  let args = argv;
  if (args[0] === 'show') args = args.slice(1);
  if (args[0] === 'expire' || args[0] === 'delete') {
    throw fatal("reflog expiry is disabled on this machine. (Deleting your safety net? Bold.)");
  }
  const a = new Args(args, ['-n']);
  let max = a.value('-n') ? parseInt(a.value('-n')!, 10) : Infinity;
  const target = a.rest.find((r) => !/^-\d+$/.test(r)) ?? 'HEAD';
  const dash = a.rest.find((r) => /^-\d+$/.test(r));
  if (dash) max = parseInt(dash.slice(1), 10);
  let ref = 'HEAD';
  let label = 'HEAD';
  if (target !== 'HEAD') {
    const r = dwimRef(repo, target);
    if (!r) throw fatal(`ambiguous argument '${target}': unknown revision or path not in the working tree.`);
    ref = r;
    label = target;
  }
  const log = [...(repo.reflogs.get(ref) ?? [])].reverse().slice(0, max);
  print(
    ctx,
    ...log.map((e, i) => `${c.yellow(shortHash(e.new))}${repo.objects.isCommit(e.new) ? decorationSuffix(repo, e.new) : ''} ${label}@{${i}}: ${e.message}`),
  );
  return 0;
}

/* ------------------------------------------------------------------------- */
/* git blame                                                                  */
/* ------------------------------------------------------------------------- */

function blameLines(repo: Repository, h: Hash, path: string, memo: Map<Hash, Hash[]>): Hash[] {
  const cached = memo.get(h);
  if (cached) return cached;
  const fh = repo.commitFiles(h).get(path);
  const lines = fh ? splitLines(repo.blob(fh)) : [];
  const result: (Hash | null)[] = new Array(lines.length).fill(null);
  for (const p of repo.parents(h)) {
    const pfh = repo.commitFiles(p).get(path);
    if (!pfh) continue;
    const plines = splitLines(repo.blob(pfh));
    const pblame = blameLines(repo, p, path, memo);
    for (const op of myersDiff(plines, lines)) {
      if (op.op === ' ' && result[op.b] === null) result[op.b] = pblame[op.a];
    }
  }
  const out = result.map((r) => r ?? h);
  memo.set(h, out);
  return out;
}

export function cmdBlame(ctx: GitContext, argv: string[]): number {
  const repo = requireRepo(ctx);
  const a = new Args(argv, ['-L']);
  const args = [...a.rest, ...(a.afterDashDash ?? [])];
  if (!args.length) throw fatal('usage: git blame [<rev>] [--] <file>');
  let rev: string | null = null;
  let fileArg = args[args.length - 1];
  if (args.length >= 2) rev = args[0];
  const path = toRepoPath(ctx, repo, fileArg);
  const start = rev ? revParseCommit(repo, rev) : repo.headHash();
  if (!start) throw fatal('no such ref: HEAD');
  const files = repo.commitFiles(start);
  if (!files.has(path)) throw fatal(`no such path '${fileArg}' in ${rev ?? 'HEAD'}`);

  const memo = new Map<Hash, Hash[]>();
  const committed = blameLines(repo, start, path, memo);
  const committedLines = splitLines(repo.blob(files.get(path)!));
  let lines = committedLines;
  let owners: (Hash | null)[] = committed;
  if (!rev && repo.worktree.has(path)) {
    // Uncommitted edits show up as "Not Committed Yet".
    lines = splitLines(repo.worktree.get(path)!);
    owners = new Array(lines.length).fill(null);
    for (const op of myersDiff(committedLines, lines)) if (op.op === ' ') owners[op.b] = committed[op.a];
  }

  let from = 1;
  let to = lines.length;
  const L = a.value('-L');
  if (L) {
    const m = /^(\d+),(\d+)$/.exec(L);
    if (m) {
      from = Math.max(1, +m[1]);
      to = Math.min(lines.length, +m[2]);
    }
  }
  const names = owners.map((h) => (h ? repo.objects.commit(h).author.name : 'Not Committed Yet'));
  const nameW = Math.max(...names.map((n) => n.length), 1);
  const numW = String(lines.length).length;
  for (let i = from - 1; i < to; i++) {
    const h = owners[i];
    const isRoot = h ? repo.parents(h).length === 0 : false;
    const hashStr = h ? (isRoot ? '^' + h.slice(0, 7) : h.slice(0, 8)) : '00000000';
    const date = h ? isoDate(repo.objects.commit(h).author.time) : isoDate(repo.world.clock.now());
    print(ctx, `${c.yellow(hashStr)} (${names[i].padEnd(nameW)} ${date} ${String(i + 1).padStart(numW)}) ${lines[i]}`);
  }
  ctx.world.emit({ type: 'blame', path });
  return 0;
}

export { filterBySpecs };
