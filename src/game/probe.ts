import { hasConflictMarkers } from '../engine/diff';
import type { HostedRepo } from '../engine/hub';
import { subject, type Hash } from '../engine/objects';
import type { Repository } from '../engine/repo';
import { tryRevParse } from '../engine/revparse';
import type { World, WorldEvent } from '../engine/world';
import type { Shell } from '../shell/shell';

/**
 * Read-only questions objectives and reactions ask about the world. Keeping these
 * in one place keeps level files short and readable.
 */
export class Probe {
  constructor(
    public world: World,
    public shell: Shell,
    private repoName: string,
    private hostedSlug?: string,
  ) {}

  get repo(): Repository | undefined {
    const r = this.world.dirs.get(this.repoName);
    return r?.initialized ? r : undefined;
  }

  get host(): HostedRepo | undefined {
    return this.hostedSlug ? this.world.hub.resolve(this.hostedSlug) : undefined;
  }

  get data(): Record<string, string> {
    return this.world.data;
  }

  get events(): WorldEvent[] {
    return this.world.events;
  }

  happened(type: string, pred: (e: WorldEvent) => boolean = () => true): boolean {
    return this.world.events.some((e) => e.type === type && pred(e));
  }

  ranGit(sub: string, pred: (args: string[]) => boolean = () => true): boolean {
    return this.world.events.some((e) => e.type === 'git' && e.cmd === sub && e.code === 0 && pred(e.args as string[]));
  }

  config(key: string): string | undefined {
    return this.world.globalConfig.get(key) ?? this.repo?.getConfig(key);
  }

  /* ----------------------------- local repo ----------------------------- */

  branch(): string | null {
    return this.repo?.currentBranch() ?? null;
  }

  inRepo(): boolean {
    return this.shell.cwd.dir === this.repoName;
  }

  file(path: string): string | undefined {
    return this.repo?.worktree.get(path);
  }

  rev(spec: string): Hash | null {
    const r = this.repo;
    return r ? tryRevParse(r, spec) : null;
  }

  /** File content in a committed snapshot (e.g. 'HEAD', 'main', 'origin/main'). */
  fileAt(spec: string, path: string): string | undefined {
    const r = this.repo;
    const h = this.rev(spec);
    if (!r || !h) return undefined;
    const b = r.commitFiles(h).get(path);
    return b ? r.blob(b) : undefined;
  }

  filesAt(spec: string): string[] {
    const r = this.repo;
    const h = this.rev(spec);
    return r && h ? [...r.commitFiles(h).keys()] : [];
  }

  subjects(spec: string, limit = 100): string[] {
    const r = this.repo;
    let h = this.rev(spec);
    const out: string[] = [];
    while (r && h && out.length < limit) {
      const co = r.objects.commit(h);
      out.push(subject(co.message));
      h = co.parents[0] ?? null;
    }
    return out;
  }

  /** Commits reachable from `to` but not `from` in the local repo. */
  range(from: string, to: string): Hash[] {
    const r = this.repo;
    const a = this.rev(from);
    const b = this.rev(to);
    if (!r || !a || !b) return [];
    const ex = r.reachable([a]);
    return [...r.reachable([b])].filter((h) => !ex.has(h));
  }

  clean(): boolean {
    return !!this.repo && this.repo.isClean() && this.repo.status().untracked.length === 0;
  }

  noConflicts(): boolean {
    return !!this.repo && this.repo.conflicts.size === 0 && !this.repo.op;
  }

  hasMarkers(path: string, spec?: string): boolean {
    const c = spec ? this.fileAt(spec, path) : this.file(path);
    return c !== undefined && hasConflictMarkers(c);
  }

  /** Does any commit reachable from `spec` contain this path? */
  historyContains(spec: string, path: string): boolean {
    const r = this.repo;
    const h = this.rev(spec);
    if (!r || !h) return false;
    for (const c of r.reachable([h])) if (r.commitFiles(c).has(path)) return true;
    return false;
  }

  /* ---------------------------- hosted repo ----------------------------- */

  remoteBranch(name: string): Hash | undefined {
    return this.host?.branchHash(name);
  }

  remoteFile(branch: string, path: string): string | undefined {
    const host = this.host;
    const h = host?.branchHash(branch) ?? host?.refs.get(`refs/tags/${branch}`);
    if (!host || !h) return undefined;
    const tipObj = host.objects.get(host.objects.peel(h));
    if (tipObj?.type !== 'commit') return undefined;
    const tree = host.objects.tree(tipObj.tree);
    const b = tree.get(path);
    return b ? host.objects.blob(b) : undefined;
  }

  /** All commits reachable from a hosted branch. */
  remoteCommits(branch: string): Set<Hash> {
    const host = this.host;
    const out = new Set<Hash>();
    const tip = host?.branchHash(branch);
    if (!host || !tip) return out;
    const stack = [tip];
    while (stack.length) {
      const h = stack.pop()!;
      if (out.has(h)) continue;
      const o = host.objects.get(h);
      if (o?.type !== 'commit') continue;
      out.add(h);
      stack.push(...o.parents);
    }
    return out;
  }

  remoteSubjects(branch: string): string[] {
    const host = this.host;
    if (!host) return [];
    return [...this.remoteCommits(branch)].map((h) => {
      const o = host.objects.get(h);
      return o?.type === 'commit' ? subject(o.message) : '';
    });
  }

  remoteHistoryContains(branch: string, path: string): boolean {
    const host = this.host;
    if (!host) return false;
    for (const h of this.remoteCommits(branch)) {
      const o = host.objects.get(h);
      if (o?.type === 'commit' && host.objects.tree(o.tree).has(path)) return true;
    }
    return false;
  }

  /** Local branch and its remote counterpart point at the same commit. */
  pushed(branch: string): boolean {
    const r = this.repo;
    const local = r?.branchHash(branch);
    return !!local && this.remoteBranch(branch) === local;
  }

  upstreamOf(branch: string): string | null {
    const up = this.repo?.upstreamOf(branch);
    return up ? `${up.remote}/${up.branch}` : null;
  }

  forcePushed(branch: string): boolean {
    return !!this.host?.forcePushes(branch).length;
  }
}
