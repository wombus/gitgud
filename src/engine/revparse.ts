import type { Hash } from './objects';
import type { Repository } from './repo';
import { fatal, GitError } from './util';

/**
 * Revision syntax: how git turns things like `HEAD~2`, `main^2`, `origin/main`,
 * `abc123f`, `HEAD@{3}`, `@{-1}`, `@{u}` and `stash@{0}` into a commit hash.
 *
 * Name lookup follows git's documented order (gitrevisions(7)):
 *   <name>, refs/<name>, refs/tags/<name>, refs/heads/<name>,
 *   refs/remotes/<name>, refs/remotes/<name>/HEAD
 */

const SPECIAL = ['HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'FETCH_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

export function unknownRevision(spec: string): GitError {
  return fatal(
    `ambiguous argument '${spec}': unknown revision or path not in the working tree.\n` +
      `Use '--' to separate paths from revisions, like this:\n` +
      `'git <command> [<revision>...] -- [<file>...]'`,
  );
}

/** Resolve a ref-like name to the full ref it names (e.g. "main" -> "refs/heads/main"). */
export function dwimRef(repo: Repository, name: string): string | null {
  const candidates = [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`];
  for (const c of candidates) if (repo.hasRef(c)) return c;
  if (repo.hasRef(`refs/remotes/${name}/HEAD`)) return `refs/remotes/${name}/HEAD`;
  return null;
}

/** Name of the Nth previously checked-out branch, from HEAD's reflog (for `checkout -`). */
export function previousBranch(repo: Repository, n = 1): string | null {
  const log = repo.reflogs.get('HEAD') ?? [];
  let seen = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const m = /^checkout: moving from (\S+) to (\S+)$/.exec(log[i].message);
    if (m && ++seen === n) return m[1];
  }
  return null;
}

function resolveUpstream(repo: Repository, branch: string | null, spec: string): Hash {
  const b = branch ?? repo.currentBranch();
  if (!b) throw fatal('HEAD does not point to a branch');
  const up = repo.upstreamOf(b);
  if (!up) throw fatal(`no upstream configured for branch '${b}'`);
  const h = repo.getRef(up.ref);
  if (!h) throw fatal(`upstream branch '${up.ref.slice(13)}' not stored as a remote-tracking branch`);
  void spec;
  return h;
}

function resolveBase(repo: Repository, base: string, spec: string): Hash {
  if (base === '@' || base === '') base = 'HEAD';

  const at = /^(.*)@\{(.+)\}$/.exec(base);
  if (at) {
    const [, name, sel] = at;
    if (/^-\d+$/.test(sel)) {
      const prev = previousBranch(repo, -parseInt(sel, 10));
      if (!prev) throw fatal(`${base}: only ${0} checkout(s) in reflog`);
      return resolveBase(repo, prev, spec);
    }
    if (sel === 'u' || sel === 'upstream') {
      return resolveUpstream(repo, name === '' || name === 'HEAD' ? null : name, spec);
    }
    if (/^\d+$/.test(sel)) {
      const n = parseInt(sel, 10);
      if (name === 'stash') {
        const h = repo.stash[n];
        if (!h) throw fatal(`log for 'stash' only has ${repo.stash.length} entries`);
        return h;
      }
      let ref: string;
      if (name === '' ) {
        ref = repo.head.kind === 'branch' ? `refs/heads/${repo.head.name}` : 'HEAD';
      } else if (name === 'HEAD') ref = 'HEAD';
      else {
        const r = dwimRef(repo, name);
        if (!r) throw unknownRevision(spec);
        ref = r;
      }
      const log = repo.reflogs.get(ref) ?? [];
      if (n >= log.length) {
        throw fatal(`log for '${name || repo.currentBranch() || 'HEAD'}' only has ${log.length} entries`);
      }
      return log[log.length - 1 - n].new;
    }
    throw unknownRevision(spec);
  }

  if (base === 'stash') {
    if (!repo.stash.length) throw unknownRevision(spec);
    return repo.stash[0];
  }

  if (base === 'HEAD') {
    const h = repo.headHash();
    if (!h) throw unknownRevision(spec);
    return h;
  }
  if (SPECIAL.includes(base)) {
    const h = repo.special.get(base);
    if (!h) throw unknownRevision(spec);
    return h;
  }

  const ref = dwimRef(repo, base);
  if (ref) return repo.getRef(ref)!;

  if (/^[0-9a-f]{4,40}$/i.test(base)) {
    const matches = repo.objects.findByPrefix(base.toLowerCase());
    const commits = matches.filter((h) => repo.objects.get(h)?.type === 'commit' || repo.objects.get(h)?.type === 'tag');
    const pool = commits.length ? commits : matches;
    if (pool.length === 1) return pool[0];
    if (pool.length > 1) throw fatal(`short object ID ${base} is ambiguous`);
  }
  throw unknownRevision(spec);
}

/** Resolve a revision to an object hash (peeling annotated tags to their commit). */
export function revParse(repo: Repository, spec: string): Hash {
  const m = /^(.*?)((?:[~^]\d*)*)$/.exec(spec);
  if (!m) throw unknownRevision(spec);
  const [, base, suffix] = m;
  if (base === '' && suffix !== '') throw unknownRevision(spec);
  let h = repo.objects.peel(resolveBase(repo, base, spec));

  const ops = suffix.match(/[~^]\d*/g) ?? [];
  for (const op of ops) {
    const kind = op[0];
    const n = op.length > 1 ? parseInt(op.slice(1), 10) : 1;
    if (!repo.objects.isCommit(h)) throw unknownRevision(spec);
    if (kind === '~') {
      for (let i = 0; i < n; i++) {
        const ps = repo.parents(h);
        if (!ps.length) throw unknownRevision(spec);
        h = ps[0];
      }
    } else {
      if (n === 0) continue;
      const ps = repo.parents(h);
      if (n > ps.length) throw unknownRevision(spec);
      h = ps[n - 1];
    }
  }
  return h;
}

/** Resolve and insist on a commit. */
export function revParseCommit(repo: Repository, spec: string): Hash {
  const h = revParse(repo, spec);
  if (!repo.objects.isCommit(h)) throw fatal(`'${spec}' is not a commit`);
  return h;
}

export function tryRevParse(repo: Repository, spec: string): Hash | null {
  try {
    return revParseCommit(repo, spec);
  } catch {
    return null;
  }
}

/**
 * Parse revision arguments for log-like commands: plain revs are included,
 * `^rev` and `A..B`'s A are excluded, and `A...B` is the symmetric difference.
 */
export function parseRevRange(
  repo: Repository,
  args: string[],
): { include: Hash[]; exclude: Hash[]; symmetric?: [Hash, Hash] } {
  const include: Hash[] = [];
  const exclude: Hash[] = [];
  let symmetric: [Hash, Hash] | undefined;
  for (const a of args) {
    const tri = /^(.*)\.\.\.(.*)$/.exec(a);
    const two = /^(.*)\.\.(.*)$/.exec(a);
    if (tri) {
      const l = revParseCommit(repo, tri[1] || 'HEAD');
      const r = revParseCommit(repo, tri[2] || 'HEAD');
      include.push(l, r);
      const base = repo.mergeBase(l, r);
      if (base) exclude.push(base);
      symmetric = [l, r];
    } else if (two) {
      exclude.push(revParseCommit(repo, two[1] || 'HEAD'));
      include.push(revParseCommit(repo, two[2] || 'HEAD'));
    } else if (a.startsWith('^')) {
      exclude.push(revParseCommit(repo, a.slice(1)));
    } else {
      include.push(revParseCommit(repo, a));
    }
  }
  return { include, exclude, symmetric };
}
