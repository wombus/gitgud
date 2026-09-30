import { ObjectStore, type Hash } from './objects';

/**
 * A pocket-sized GitHub. Hosted repos are bare repositories (objects + refs, no
 * working tree) plus the social layer git itself knows nothing about: pull
 * requests, issues, and branch protection rules.
 */

export interface BranchProtection {
  /** Direct pushes are rejected; changes must go through a PR. */
  requirePullRequest: boolean;
  allowForcePush: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  createdAt: number;
  mergedCommit?: Hash;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  reviews: Array<{ author: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; body: string }>;
  comments: Array<{ author: string; body: string }>;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  author: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  createdAt: number;
  comments: Array<{ author: string; body: string }>;
  closedBy?: string;
}

export interface PushEvent {
  kind: 'push';
  repo: string;
  ref: string;
  old: Hash | null;
  new: Hash | null;
  forced: boolean;
  by: string;
}

export class HostedRepo {
  objects = new ObjectStore();
  refs = new Map<string, Hash>();
  defaultBranch = 'main';
  protection = new Map<string, BranchProtection>();
  pulls: PullRequest[] = [];
  issues: Issue[] = [];
  nextNumber = 1;
  events: PushEvent[] = [];
  description = '';
  /** PRs into protected branches need an approving review before `gh pr merge`. */
  requireApproval = false;

  constructor(
    public owner: string,
    public name: string,
  ) {}

  get slug(): string {
    return `${this.owner}/${this.name}`;
  }

  get sshUrl(): string {
    return `git@github.com:${this.slug}.git`;
  }

  get webUrl(): string {
    return `https://github.com/${this.slug}`;
  }

  branchHash(name: string): Hash | undefined {
    return this.refs.get(`refs/heads/${name}`);
  }

  branches(): string[] {
    return [...this.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .map((r) => r.slice(11))
      .sort();
  }

  protect(branch: string, rules: Partial<BranchProtection> = {}): void {
    this.protection.set(branch, { requirePullRequest: true, allowForcePush: false, ...rules });
  }

  pull(n: number): PullRequest | undefined {
    return this.pulls.find((p) => p.number === n);
  }

  issue(n: number): Issue | undefined {
    return this.issues.find((i) => i.number === n);
  }

  openIssue(i: Omit<Issue, 'number' | 'state' | 'comments' | 'labels' | 'assignees'> & Partial<Issue>): Issue {
    const issue: Issue = {
      state: 'open',
      comments: [],
      labels: [],
      assignees: [],
      ...i,
      number: this.nextNumber++,
    };
    this.issues.push(issue);
    return issue;
  }

  /** Was this commit ever force-pushed away from `branch`? Used by fail conditions. */
  forcePushes(branch?: string): PushEvent[] {
    return this.events.filter((e) => e.forced && (!branch || e.ref === `refs/heads/${branch}`));
  }
}

export class Hub {
  repos = new Map<string, HostedRepo>();

  create(owner: string, name: string): HostedRepo {
    const r = new HostedRepo(owner, name);
    this.repos.set(r.slug.toLowerCase(), r);
    return r;
  }

  /** Accepts git@github.com:o/r.git, https://github.com/o/r(.git), or o/r. */
  resolve(url: string): HostedRepo | undefined {
    const m =
      /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url) ??
      /^(?:https?:\/\/)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url) ??
      /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
    if (!m) return undefined;
    return this.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
  }
}
