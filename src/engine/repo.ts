import { hashObject, ObjectStore, type FileMap, type Hash, type Person, type Signature } from './objects';
import { isIgnored as ignoreMatch } from './util';
import type { World } from './world';

/**
 * A git repository (plus the project directory it lives in).
 *
 * The three "trees" every git user eventually has to understand live here:
 *
 *   HEAD      -> the last commit on the current branch (a snapshot)
 *   index     -> the staging area: the snapshot your *next* commit will record
 *   worktree  -> the actual files on disk that you edit
 *
 * `git add` copies worktree -> index. `git commit` turns the index into a commit
 * and moves the branch (and therefore HEAD) to it. `git status` is just a report
 * of the differences between these three.
 */

export const ZERO_HASH = '0'.repeat(40);

export type Head = { kind: 'branch'; name: string } | { kind: 'detached'; hash: Hash };

export interface ReflogEntry {
  old: Hash;
  new: Hash;
  who: Signature;
  message: string;
}

/** An unmerged path: git keeps up to three versions ("stages") of it in the index. */
export interface ConflictEntry {
  base?: Hash; // stage 1: common ancestor
  ours?: Hash; // stage 2: HEAD's version
  theirs?: Hash; // stage 3: the version being merged in
}

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseStep {
  action: RebaseAction;
  commit: Hash;
}

export type Operation =
  | { kind: 'merge'; mergeHead: Hash; message: string; squash?: boolean; touched: string[] }
  | {
      kind: 'cherry-pick' | 'revert';
      current: Hash;
      todo: Hash[];
      message: string;
      author?: Signature;
      mainline?: number;
      recordOrigin?: boolean;
      /** HEAD before the whole sequence started (for --abort). */
      origHead: Hash;
      /** Set when the user concluded the current pick with `git commit` themselves. */
      committed?: boolean;
    }
  | {
      kind: 'rebase';
      interactive: boolean;
      headName: string | null;
      origHead: Hash;
      onto: Hash;
      todo: RebaseStep[];
      done: RebaseStep[];
      current: RebaseStep | null;
      stopReason: 'conflict' | 'edit' | null;
      /** HEAD when the current step started (to notice a manual `git commit`). */
      stepBase: Hash | null;
      /** Messages collected while squashing, applied when the squash group ends. */
      squashMessages: string[] | null;
      total: number;
    };

export interface BisectState {
  originalHead: Head;
  good: Hash[];
  bad: Hash | null;
  skipped: Hash[];
  log: string[];
}

export interface StagedChange {
  status: 'A' | 'M' | 'D' | 'R';
  path: string;
  from?: string;
}

export interface UnstagedChange {
  status: 'M' | 'D';
  path: string;
}

export interface UnmergedPath {
  path: string;
  code: string;
  label: string;
}

export interface StatusInfo {
  staged: StagedChange[];
  unstaged: UnstagedChange[];
  untracked: string[];
  unmerged: UnmergedPath[];
}

export function blobHash(content: string): Hash {
  return hashObject({ type: 'blob', content });
}

function normKey(key: string): string {
  const parts = key.split('.');
  if (parts.length < 2) return key.toLowerCase();
  parts[0] = parts[0].toLowerCase();
  parts[parts.length - 1] = parts[parts.length - 1].toLowerCase();
  return parts.join('.');
}

export class Repository {
  /** False for a plain directory that hasn't been `git init`-ed. */
  initialized = true;
  objects = new ObjectStore();
  refs = new Map<string, Hash>();
  /** Symbolic refs other than HEAD, e.g. refs/remotes/origin/HEAD -> refs/remotes/origin/main */
  symrefs = new Map<string, string>();
  head: Head = { kind: 'branch', name: 'main' };
  index = new Map<string, Hash>();
  conflicts = new Map<string, ConflictEntry>();
  worktree = new Map<string, string>();
  emptyDirs = new Set<string>();
  config = new Map<string, string>();
  reflogs = new Map<string, ReflogEntry[]>();
  /** ORIG_HEAD, MERGE_HEAD, FETCH_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD */
  special = new Map<string, Hash>();
  op: Operation | null = null;
  bisect: BisectState | null = null;
  /** Stash commits, newest first (stash@{0}). */
  stash: Hash[] = [];
  /** What `git status` should call a detached HEAD ("HEAD detached at <label>"). */
  detachedFrom: { label: string; hash: Hash } | null = null;

  constructor(
    public world: World,
    public name: string,
  ) {}

  /* ------------------------------ config ------------------------------ */

  getConfig(key: string): string | undefined {
    const k = normKey(key);
    return this.config.get(k) ?? this.world.globalConfig.get(k);
  }

  setConfig(key: string, value: string): void {
    this.config.set(normKey(key), value);
  }

  unsetConfig(key: string): boolean {
    return this.config.delete(normKey(key));
  }

  identity(): Person | null {
    const name = this.getConfig('user.name');
    const email = this.getConfig('user.email');
    if (!name || !email) return null;
    return { name, email };
  }

  signature(person?: Person | null): Signature {
    const p = person ?? this.identity() ?? { name: this.world.user, email: `${this.world.user}@${this.world.host}` };
    return { ...p, time: this.world.clock.stamp() };
  }

  /* ------------------------------- refs ------------------------------- */

  getRef(ref: string): Hash | undefined {
    const target = this.symrefs.get(ref);
    return this.refs.get(target ?? ref);
  }

  hasRef(ref: string): boolean {
    return this.getRef(ref) !== undefined;
  }

  branchHash(name: string): Hash | undefined {
    return this.refs.get(`refs/heads/${name}`);
  }

  branches(): string[] {
    return [...this.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .map((r) => r.slice('refs/heads/'.length))
      .sort();
  }

  tags(): string[] {
    return [...this.refs.keys()]
      .filter((r) => r.startsWith('refs/tags/'))
      .map((r) => r.slice('refs/tags/'.length))
      .sort();
  }

  remoteBranches(remote?: string): string[] {
    const prefix = remote ? `refs/remotes/${remote}/` : 'refs/remotes/';
    return [...this.refs.keys()]
      .filter((r) => r.startsWith(prefix) && !r.endsWith('/HEAD'))
      .map((r) => r.slice('refs/remotes/'.length))
      .sort();
  }

  currentBranch(): string | null {
    return this.head.kind === 'branch' ? this.head.name : null;
  }

  /** The commit HEAD points at, or null on an unborn branch (no commits yet). */
  headHash(): Hash | null {
    if (this.head.kind === 'detached') return this.head.hash;
    return this.branchHash(this.head.name) ?? null;
  }

  appendReflog(ref: string, old: Hash, next: Hash, message: string): void {
    const list = this.reflogs.get(ref) ?? [];
    list.push({ old, new: next, who: this.signature(), message });
    this.reflogs.set(ref, list);
  }

  /** Move any ref, logging it (and HEAD, if it's the checked-out branch). */
  setRef(ref: string, hash: Hash, message: string): void {
    const old = this.refs.get(ref) ?? ZERO_HASH;
    this.refs.set(ref, hash);
    this.appendReflog(ref, old, hash, message);
    if (this.head.kind === 'branch' && `refs/heads/${this.head.name}` === ref) {
      this.appendReflog('HEAD', old, hash, message);
    }
  }

  /** Update a ref without touching reflogs (remote-tracking refs, mostly). */
  setRefQuiet(ref: string, hash: Hash): void {
    this.refs.set(ref, hash);
  }

  deleteRef(ref: string): void {
    this.refs.delete(ref);
    this.reflogs.delete(ref);
    for (const [k, v] of this.symrefs) if (v === ref || k === ref) this.symrefs.delete(k);
  }

  /** Move whatever HEAD points at (the current branch, or HEAD itself when detached). */
  moveHead(hash: Hash, message: string): void {
    if (this.head.kind === 'branch') {
      this.setRef(`refs/heads/${this.head.name}`, hash, message);
    } else {
      const old = this.head.hash;
      this.head = { kind: 'detached', hash };
      this.appendReflog('HEAD', old, hash, message);
    }
  }

  /** Point HEAD at a branch (symbolic ref). Does not touch the index/worktree. */
  attachHead(branch: string, message: string): void {
    const old = this.headHash() ?? ZERO_HASH;
    this.head = { kind: 'branch', name: branch };
    this.detachedFrom = null;
    this.appendReflog('HEAD', old, this.branchHash(branch) ?? ZERO_HASH, message);
  }

  detachHead(hash: Hash, message: string, label?: string): void {
    const old = this.headHash() ?? ZERO_HASH;
    this.head = { kind: 'detached', hash };
    if (label !== undefined) this.detachedFrom = { label, hash };
    this.appendReflog('HEAD', old, hash, message);
  }

  upstreamOf(branch: string): { remote: string; branch: string; ref: string } | null {
    const remote = this.getConfig(`branch.${branch}.remote`);
    const merge = this.getConfig(`branch.${branch}.merge`);
    if (!remote || !merge) return null;
    const b = merge.replace(/^refs\/heads\//, '');
    return { remote, branch: b, ref: `refs/remotes/${remote}/${b}` };
  }

  setUpstream(branch: string, remote: string, remoteBranch: string): void {
    this.setConfig(`branch.${branch}.remote`, remote);
    this.setConfig(`branch.${branch}.merge`, `refs/heads/${remoteBranch}`);
  }

  unsetUpstream(branch: string): void {
    this.unsetConfig(`branch.${branch}.remote`);
    this.unsetConfig(`branch.${branch}.merge`);
  }

  remotes(): string[] {
    const out = new Set<string>();
    for (const k of this.config.keys()) {
      const m = /^remote\.(.+)\.url$/.exec(k);
      if (m) out.add(m[1]);
    }
    return [...out].sort();
  }

  remoteUrl(name: string): string | undefined {
    return this.getConfig(`remote.${name}.url`);
  }

  /* ----------------------------- snapshots ----------------------------- */

  commitFiles(h: Hash): FileMap {
    return this.objects.commitFiles(h);
  }

  headFiles(): FileMap {
    const h = this.headHash();
    return h ? this.commitFiles(h) : new Map();
  }

  writeTree(files: FileMap): Hash {
    return this.objects.putTree(files);
  }

  blob(h: Hash): string {
    return this.objects.blob(h);
  }

  /** Hash of a worktree file's current content (without storing it). */
  worktreeHash(path: string): Hash | undefined {
    const c = this.worktree.get(path);
    return c === undefined ? undefined : blobHash(c);
  }

  /** Snapshot of the worktree's *tracked* files as a FileMap (stores blobs). */
  worktreeFiles(opts: { includeUntracked?: boolean } = {}): FileMap {
    const out: FileMap = new Map();
    for (const [p, content] of this.worktree) {
      if (!opts.includeUntracked && !this.index.has(p) && !this.conflicts.has(p)) continue;
      out.set(p, this.objects.putBlob(content));
    }
    return out;
  }

  makeCommit(
    tree: Hash,
    parents: Hash[],
    message: string,
    opts: { author?: Signature; committer?: Signature } = {},
  ): Hash {
    const committer = opts.committer ?? this.signature();
    const author = opts.author ?? { ...committer };
    return this.objects.put({ type: 'commit', tree, parents, author, committer, message });
  }

  /* ------------------------------ history ------------------------------ */

  parents(h: Hash): Hash[] {
    return this.objects.commit(h).parents;
  }

  /** All commits reachable from the given tips (including the tips). */
  reachable(tips: Iterable<Hash>): Set<Hash> {
    const seen = new Set<Hash>();
    const stack = [...tips];
    while (stack.length) {
      const h = stack.pop()!;
      if (seen.has(h) || !this.objects.isCommit(h)) continue;
      seen.add(h);
      stack.push(...this.objects.commit(h).parents);
    }
    return seen;
  }

  isAncestor(ancestor: Hash, descendant: Hash): boolean {
    if (ancestor === descendant) return true;
    return this.reachable([descendant]).has(ancestor);
  }

  /** Best common ancestor of two commits (what git merges against). */
  mergeBase(a: Hash, b: Hash): Hash | null {
    const ra = this.reachable([a]);
    const common = [...this.reachable([b])].filter((h) => ra.has(h));
    if (!common.length) return null;
    const best = common.filter((c) => !common.some((d) => d !== c && this.isAncestor(c, d)));
    best.sort((x, y) => this.objects.commit(y).committer.time - this.objects.commit(x).committer.time);
    return best[0];
  }

  /** Commits reachable from `to` but not from `from` (i.e. `from..to`). */
  rangeCount(from: Hash, to: Hash): number {
    const exclude = this.reachable([from]);
    let n = 0;
    for (const h of this.reachable([to])) if (!exclude.has(h)) n++;
    return n;
  }

  /** Every ref name -> hash, including HEAD, for "is this commit still reachable?" questions. */
  allRefTips(): Hash[] {
    const tips = [...this.refs.values()];
    const h = this.headHash();
    if (h) tips.push(h);
    tips.push(...this.stash);
    return tips.map((t) => this.objects.peel(t));
  }

  /* ------------------------------- status ------------------------------ */

  gitignore(): string | undefined {
    return this.worktree.get('.gitignore');
  }

  isIgnored(path: string): boolean {
    return ignoreMatch(path, this.gitignore());
  }

  isTracked(path: string): boolean {
    return this.index.has(path) || this.conflicts.has(path);
  }

  status(): StatusInfo {
    const headF = this.headFiles();
    const staged: StagedChange[] = [];
    const paths = new Set([...headF.keys(), ...this.index.keys()]);
    const added: string[] = [];
    const deleted: string[] = [];
    for (const p of [...paths].sort()) {
      if (this.conflicts.has(p)) continue;
      const h = headF.get(p);
      const i = this.index.get(p);
      if (h === i) continue;
      if (h === undefined) added.push(p);
      else if (i === undefined) deleted.push(p);
      else staged.push({ status: 'M', path: p });
    }
    // Exact-content rename detection (what `git mv` produces).
    for (const d of [...deleted]) {
      const dh = headF.get(d);
      const match = added.find((a) => this.index.get(a) === dh);
      if (match) {
        staged.push({ status: 'R', path: match, from: d });
        deleted.splice(deleted.indexOf(d), 1);
        added.splice(added.indexOf(match), 1);
      }
    }
    for (const a of added) staged.push({ status: 'A', path: a });
    for (const d of deleted) staged.push({ status: 'D', path: d });
    staged.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

    const unstaged: UnstagedChange[] = [];
    for (const [p, h] of [...this.index].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      if (!this.worktree.has(p)) unstaged.push({ status: 'D', path: p });
      else if (this.worktreeHash(p) !== h) unstaged.push({ status: 'M', path: p });
    }

    const unmerged: UnmergedPath[] = [];
    for (const [p, e] of [...this.conflicts].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      unmerged.push({ path: p, ...describeConflict(e) });
    }

    return { staged, unstaged, untracked: this.untrackedPaths(), unmerged };
  }

  /** Untracked, non-ignored paths, collapsing wholly-untracked directories to "dir/". */
  untrackedPaths(): string[] {
    const tracked = [...this.index.keys(), ...this.conflicts.keys()];
    const out = new Set<string>();
    for (const p of [...this.worktree.keys()].sort()) {
      if (this.isTracked(p) || this.isIgnored(p)) continue;
      const segs = p.split('/');
      let shown = p;
      for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join('/') + '/';
        if (!tracked.some((t) => t.startsWith(dir))) {
          shown = dir;
          break;
        }
      }
      out.add(shown);
    }
    return [...out];
  }

  isClean(): boolean {
    const s = this.status();
    return !s.staged.length && !s.unstaged.length && !s.unmerged.length;
  }

  hasStagedChanges(): boolean {
    return this.status().staged.length > 0;
  }

  /* ------------------------- index <-> worktree ------------------------ */

  /** Set index + worktree for one path from a blob hash (undefined = delete). */
  writePath(path: string, h: Hash | undefined): void {
    this.conflicts.delete(path);
    if (h === undefined) {
      this.index.delete(path);
      this.worktree.delete(path);
    } else {
      this.index.set(path, h);
      this.worktree.set(path, this.blob(h));
    }
  }

  /** Make index (and optionally worktree) exactly match a snapshot. */
  resetTo(files: FileMap, opts: { worktree: boolean }): void {
    const old = new Set([...this.index.keys(), ...this.conflicts.keys()]);
    this.index = new Map(files);
    this.conflicts.clear();
    if (opts.worktree) {
      for (const p of old) if (!files.has(p)) this.worktree.delete(p);
      for (const [p, h] of files) this.worktree.set(p, this.blob(h));
    }
  }

  /**
   * Which local changes would a switch from HEAD to `target` clobber?
   * This is the check behind "Your local changes to the following files would be
   * overwritten by checkout". Changes to files that are identical in both commits
   * are simply carried over to the other branch.
   */
  switchBlockers(target: FileMap): { dirty: string[]; untracked: string[] } {
    const headF = this.headFiles();
    const dirty: string[] = [];
    const untracked: string[] = [];
    const paths = new Set([...headF.keys(), ...target.keys(), ...this.index.keys(), ...this.conflicts.keys()]);
    for (const p of [...paths].sort()) {
      const h = headF.get(p);
      const t = target.get(p);
      if (h === t) continue;
      if (this.conflicts.has(p)) {
        dirty.push(p);
        continue;
      }
      const i = this.index.get(p);
      const w = this.worktreeHash(p);
      if (i === t && w === t) continue; // already matches the target
      if (i !== h || w !== i) dirty.push(p);
    }
    for (const [p, h] of target) {
      if (headF.has(p) || this.isTracked(p)) continue;
      const w = this.worktreeHash(p);
      if (w !== undefined && w !== h) untracked.push(p);
    }
    return { dirty, untracked };
  }

  /** Carry out a HEAD -> target switch on index/worktree (call switchBlockers first). */
  switchTo(target: FileMap): void {
    const headF = this.headFiles();
    const paths = new Set([...headF.keys(), ...target.keys()]);
    for (const p of paths) {
      const h = headF.get(p);
      const t = target.get(p);
      if (h === t) continue;
      this.writePath(p, t);
    }
  }
}

export function describeConflict(e: ConflictEntry): { code: string; label: string } {
  const b = e.base !== undefined;
  const o = e.ours !== undefined;
  const t = e.theirs !== undefined;
  if (b && o && t) return { code: 'UU', label: 'both modified' };
  if (b && o && !t) return { code: 'UD', label: 'deleted by them' };
  if (b && !o && t) return { code: 'DU', label: 'deleted by us' };
  if (!b && o && t) return { code: 'AA', label: 'both added' };
  if (!b && o && !t) return { code: 'AU', label: 'added by us' };
  if (!b && !o && t) return { code: 'UA', label: 'added by them' };
  return { code: 'DD', label: 'both deleted' };
}
