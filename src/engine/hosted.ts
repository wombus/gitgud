import { mergeTrees } from './commands/merging';
import { hostedCommitsBetween, updateHostedRef } from './commands/remote';
import type { HostedRepo, PullRequest } from './hub';
import { subject, type FileMap, type Hash, type Person } from './objects';
import { Repository } from './repo';
import type { World } from './world';

/**
 * Server-side operations on a hosted ("GitHub") repository. We reuse the
 * Repository class as a *bare* view: same object store and refs, no worktree.
 */

export function bareView(world: World, host: HostedRepo): Repository {
  const r = new Repository(world, `${host.name}.git`);
  r.objects = host.objects;
  r.refs = host.refs;
  r.head = { kind: 'branch', name: host.defaultBranch };
  return r;
}

export interface FileChanges {
  [path: string]: string | null; // null = delete
}

/** Commit directly on the hosted repo, as a coworker would by pushing. */
export function hostedCommit(
  world: World,
  host: HostedRepo,
  branch: string,
  changes: FileChanges,
  message: string,
  author: Person,
  opts: { parents?: Hash[]; minutesLater?: number } = {},
): Hash {
  const bare = bareView(world, host);
  const parent = opts.parents ?? (host.branchHash(branch) ? [host.branchHash(branch)!] : []);
  const files: FileMap = parent.length ? bare.commitFiles(parent[0]) : new Map();
  for (const [p, content] of Object.entries(changes)) {
    if (content === null) files.delete(p);
    else files.set(p, host.objects.putBlob(content));
  }
  if (opts.minutesLater) world.clock.advance(opts.minutesLater * 60);
  const sig = { ...author, time: world.clock.stamp() };
  const h = bare.makeCommit(bare.writeTree(files), parent, message, { author: sig, committer: sig });
  updateHostedRef(host, `refs/heads/${branch}`, h, false, author.name);
  return h;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface PrMergeResult {
  ok: boolean;
  reason?: string;
  commit?: Hash;
}

/** Can the PR's head be merged into its base without conflicts? */
export function prConflicts(world: World, host: HostedRepo, pr: PullRequest): string[] {
  const bare = bareView(world, host);
  const base = host.branchHash(pr.base);
  const head = host.branchHash(pr.head);
  if (!base || !head) return [];
  const mb = bare.mergeBase(base, head);
  if (!mb) return ['(unrelated histories)'];
  const r = mergeTrees(bare, bare.commitFiles(mb), bare.commitFiles(base), bare.commitFiles(head), 'base', 'head');
  return [...r.conflicts.keys()];
}

export function mergePullRequest(world: World, host: HostedRepo, pr: PullRequest, method: MergeMethod, by: Person): PrMergeResult {
  const bare = bareView(world, host);
  const base = host.branchHash(pr.base);
  const head = host.branchHash(pr.head);
  if (!base || !head) return { ok: false, reason: 'head or base branch no longer exists' };
  if (bare.isAncestor(head, base)) return { ok: false, reason: 'no new commits to merge' };
  const conflicts = prConflicts(world, host, pr);
  if (conflicts.length) return { ok: false, reason: 'the merge commit cannot be cleanly created' };

  const mb = bare.mergeBase(base, head)!;
  const r = mergeTrees(bare, bare.commitFiles(mb), bare.commitFiles(base), bare.commitFiles(head), 'base', 'head');
  const tree = bare.writeTree(r.files);
  const sig = { ...by, time: world.clock.stamp() };
  const prCommits = hostedCommitsBetween(host, base, head)
    .filter((h) => bare.parents(h).length <= 1)
    .sort((a, b) => bare.objects.commit(a).committer.time - bare.objects.commit(b).committer.time);

  let result: Hash;
  if (method === 'merge') {
    result = bare.makeCommit(tree, [base, head], `Merge pull request #${pr.number} from ${host.owner}/${pr.head}\n\n${pr.title}`, {
      author: sig,
      committer: sig,
    });
  } else if (method === 'squash') {
    const body = prCommits.map((h) => `* ${subject(bare.objects.commit(h).message)}`).join('\n\n');
    const first = prCommits[0] ? bare.objects.commit(prCommits[0]).author : sig;
    result = bare.makeCommit(tree, [base], `${pr.title} (#${pr.number})\n\n${body}`, { author: { ...first, time: sig.time }, committer: sig });
  } else {
    // Rebase: replay each PR commit onto the base.
    let cur = base;
    for (const h of prCommits) {
      const co = bare.objects.commit(h);
      const parent = co.parents[0];
      const step = mergeTrees(bare, bare.commitFiles(parent), bare.commitFiles(cur), bare.commitFiles(h), 'base', 'head');
      if (step.conflicts.size) return { ok: false, reason: 'the pull request cannot be rebased cleanly' };
      cur = bare.makeCommit(bare.writeTree(step.files), [cur], co.message, { author: co.author, committer: { ...sig, time: world.clock.stamp() } });
    }
    result = cur;
  }
  updateHostedRef(host, `refs/heads/${pr.base}`, result, false, by.name);
  pr.state = 'merged';
  pr.mergedCommit = result;
  pr.mergeMethod = method;
  // "Closes #N" in the PR body closes issues too.
  for (const m of pr.body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) {
    const issue = host.issue(parseInt(m[1], 10));
    if (issue && issue.state === 'open' && pr.base === host.defaultBranch) {
      issue.state = 'closed';
      issue.closedBy = by.name;
    }
  }
  return { ok: true, commit: result };
}
