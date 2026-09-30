import { cloneInto } from '../engine/commands/remote';
import { hostedCommit, type FileChanges } from '../engine/hosted';
import type { HostedRepo, Issue } from '../engine/hub';
import type { Hash, Person } from '../engine/objects';
import type { Repository } from '../engine/repo';
import { officeTime } from '../engine/util';
import type { TestRun, World } from '../engine/world';
import { Shell } from '../shell/shell';

/**
 * Helpers for level setup code. Setup builds history by driving the same engine
 * the player uses (so everything is consistent), just silently.
 */

export class HostedBuilder {
  constructor(
    private world: World,
    public host: HostedRepo,
  ) {}

  commit(branch: string, files: FileChanges, message: string, author: Person, opts: { minutes?: number; parents?: Hash[] } = {}): Hash {
    return hostedCommit(this.world, this.host, branch, files, message, author, { minutesLater: opts.minutes ?? 37, parents: opts.parents });
  }

  branch(name: string, from: string): void {
    const h = this.host.branchHash(from) ?? from;
    this.host.refs.set(`refs/heads/${name}`, h);
  }

  tag(name: string, at: Hash | string): void {
    const h = this.host.branchHash(at) ?? at;
    this.host.refs.set(`refs/tags/${name}`, h);
  }

  /** Forcibly point a branch somewhere (as if someone force-pushed). */
  forceBranch(name: string, to: Hash): void {
    this.host.refs.set(`refs/heads/${name}`, to);
  }

  issue(i: Partial<Issue> & { title: string; body: string; author: string }): Issue {
    return this.host.openIssue({ createdAt: this.world.clock.now(), ...i });
  }

  protect(branch: string, rules: { requirePullRequest?: boolean; allowForcePush?: boolean } = {}): void {
    this.host.protect(branch, rules);
  }
}

export class LevelBuilder {
  constructor(
    public world: World,
    public shell: Shell,
  ) {}

  /** Set the in-game clock (office time). */
  at(time: string): void {
    this.world.clock.t = officeTime(time);
  }

  hub(owner: string, name: string, opts: { description?: string; defaultBranch?: string } = {}): HostedBuilder {
    const host = this.world.hub.create(owner, name);
    if (opts.description) host.description = opts.description;
    if (opts.defaultBranch) host.defaultBranch = opts.defaultBranch;
    return new HostedBuilder(this.world, host);
  }

  clone(h: HostedBuilder, dir = h.host.name): Repository {
    return cloneInto({ world: this.world }, h.host, h.host.sshUrl, dir);
  }

  /** Run shell commands silently inside ~/<dir> (or ~ when dir is null). Throws on failure. */
  async run(dir: string | null, ...cmds: string[]): Promise<void> {
    const saved = { ...this.shell.cwd };
    this.shell.cwd = { dir, sub: '' };
    for (const cmd of cmds) {
      const r = await this.shell.run(cmd);
      if (r.code !== 0) {
        this.shell.cwd = saved;
        throw new Error(`level setup command failed (${r.code}): ${cmd}\n${r.lines.join('\n')}`);
      }
    }
    this.shell.cwd = saved;
    this.shell.history = [];
  }

  /** Write files in a project directory directly. */
  write(dir: string, files: Record<string, string>): void {
    const repo = this.world.dirs.get(dir);
    if (!repo) throw new Error(`no such dir: ${dir}`);
    for (const [p, c] of Object.entries(files)) repo.worktree.set(p, c);
  }

  /** Where the player's shell starts. */
  cwd(dir: string | null, sub = ''): void {
    this.shell.cwd = { dir, sub };
    this.shell.prevCwd = null;
  }

  tests(runner: (repo: Repository) => TestRun): void {
    this.world.testRunner = runner;
  }
}
