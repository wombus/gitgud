import { c } from '../engine/ansi';
import { print, type GitContext } from '../engine/context';
import { diffFileMaps, formatPatch } from '../engine/format';
import { bareView, mergePullRequest, prConflicts, type MergeMethod } from '../engine/hosted';
import type { HostedRepo, PullRequest } from '../engine/hub';
import { subject } from '../engine/objects';
import { Args, relativeTime } from '../engine/util';
import { runGit } from '../engine/git';
import type { Shell } from './shell';

/**
 * A simulated GitHub CLI. `gh` talks to GitHub's API rather than to git, so it
 * knows about pull requests, reviews and issues - the collaboration layer that
 * lives on the server, not in your .git folder.
 */

const PLAYER_LOGIN = 'junior-dev';

class GhError extends Error {
  constructor(
    public lines: string[],
    public code = 1,
  ) {
    super(lines.join('\n'));
  }
}

function resolveHost(ctx: GitContext): HostedRepo {
  const repo = ctx.dir?.initialized ? ctx.dir : null;
  if (!repo) throw new GhError(['failed to run git: fatal: not a git repository (or any of the parent directories): .git']);
  const remotes = repo.remotes();
  if (!remotes.length) throw new GhError(['no git remotes found']);
  const url = repo.remoteUrl(remotes.includes('origin') ? 'origin' : remotes[0])!;
  const host = ctx.world.hub.resolve(url);
  if (!host) throw new GhError([`GraphQL: Could not resolve to a Repository with the name '${url}'. (repository)`]);
  return host;
}

function findPr(host: HostedRepo, ctx: GitContext, arg: string | undefined): PullRequest {
  if (arg) {
    const n = parseInt(arg.replace(/^#/, ''), 10);
    const pr = Number.isNaN(n) ? host.pulls.find((p) => p.head === arg && p.state === 'open') : host.pull(n);
    if (!pr) throw new GhError([`GraphQL: Could not resolve to a PullRequest with the number of ${arg}. (repository.pullRequest)`]);
    return pr;
  }
  const branch = ctx.dir?.currentBranch();
  const pr = host.pulls.find((p) => p.head === branch && p.state === 'open') ?? host.pulls.find((p) => p.head === branch);
  if (!pr) throw new GhError([`no pull requests found for branch "${branch}"`]);
  return pr;
}

function stateBadge(state: string): string {
  if (state === 'open') return c.green('Open');
  if (state === 'merged') return c.magenta('Merged');
  return c.red('Closed');
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].replace(/\x1b\[[0-9;]*m/g, '').length)));
  return rows.map((r) => r.map((cell, i) => cell + ' '.repeat(widths[i] - cell.replace(/\x1b\[[0-9;]*m/g, '').length)).join('  ').trimEnd());
}

async function prCommand(ctx: GitContext, sh: Shell, sub: string, argv: string[]): Promise<number> {
  const host = resolveHost(ctx);
  const repo = ctx.dir!;
  const now = ctx.world.clock.now();
  switch (sub) {
    case 'create': {
      const a = new Args(argv, ['-t', '--title', '-b', '--body', '-B', '--base', '-H', '--head', '-l', '--label', '-r', '--reviewer', '-a', '--assignee']);
      const head = a.value('-H', '--head') ?? repo.currentBranch();
      if (!head) throw new GhError(['could not determine the current branch: not on any branch']);
      const base = a.value('-B', '--base') ?? host.defaultBranch;
      if (head === base) throw new GhError([`head branch "${head}" is the same as base branch "${base}", cannot create a pull request`]);
      const headHash = host.branchHash(head);
      if (!headHash) {
        throw new GhError([
          `aborted: you must first push the current branch to a remote, or use the --head flag`,
          c.gray(`(try: git push -u origin ${head})`),
        ]);
      }
      const localHead = repo.branchHash(head);
      if (localHead && localHead !== headHash && !repo.isAncestor(localHead, headHash)) {
        print(ctx, c.yellow(`Warning: your local '${head}' has commits that are not pushed yet`));
      }
      const existing = host.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
      if (existing) throw new GhError([`a pull request for branch "${head}" into branch "${base}" already exists:`, `${host.webUrl}/pull/${existing.number}`]);
      const bare = bareView(ctx.world, host);
      const baseHash = host.branchHash(base);
      if (!baseHash) throw new GhError([`base branch "${base}" does not exist on the remote`]);
      if (bare.isAncestor(headHash, baseHash)) {
        throw new GhError([`pull request create failed: GraphQL: No commits between ${base} and ${head} (createPullRequest)`]);
      }
      let title = a.value('-t', '--title');
      let body = a.value('-b', '--body');
      if (a.has('-f', '--fill')) {
        const commits = bare.reachable([headHash]);
        const baseSet = bare.reachable([baseHash]);
        const mine = [...commits].filter((h) => !baseSet.has(h)).sort((x, y) => bare.objects.commit(x).committer.time - bare.objects.commit(y).committer.time);
        title = title ?? subject(bare.objects.commit(mine[0]).message);
        body = body ?? (mine.length > 1 ? mine.map((h) => `- ${subject(bare.objects.commit(h).message)}`).join('\n') : bare.objects.commit(mine[0]).message.split('\n').slice(2).join('\n'));
      }
      if (!title || body === undefined) {
        throw new GhError(['must provide `--title` and `--body` (or `--fill`) when not running interactively']);
      }
      const pr: PullRequest = {
        number: host.nextNumber++,
        title,
        body,
        head,
        base,
        author: PLAYER_LOGIN,
        state: 'open',
        draft: a.has('-d', '--draft'),
        createdAt: now,
        reviews: [],
        comments: [],
      };
      host.pulls.push(pr);
      print(ctx, '', `Creating ${pr.draft ? 'draft ' : ''}pull request for ${c.cyan(head)} into ${c.cyan(base)} in ${host.slug}`, '', `${host.webUrl}/pull/${pr.number}`);
      ctx.world.emit({ type: 'pr-create', number: pr.number, head, base, title });
      return 0;
    }
    case 'list': {
      const a = new Args(argv, ['-s', '--state', '-B', '--base', '-H', '--head', '-A', '--author']);
      const state = a.value('-s', '--state') ?? 'open';
      const prs = host.pulls.filter((p) => state === 'all' || p.state === state).sort((x, y) => y.number - x.number);
      if (!prs.length) {
        print(ctx, '', `no ${state === 'all' ? '' : state + ' '}pull requests in ${host.slug}`);
        return 0;
      }
      print(ctx, '', `Showing ${prs.length} of ${prs.length} ${state === 'all' ? '' : state + ' '}pull request${prs.length === 1 ? '' : 's'} in ${host.slug}`, '');
      const rows = [[c.bold('ID'), c.bold('TITLE'), c.bold('BRANCH'), c.bold('CREATED AT')]];
      for (const p of prs) rows.push([c.green(`#${p.number}`), p.title, c.cyan(p.head), relativeTime(p.createdAt, now).replace(/^(\d)/, 'about $1')]);
      print(ctx, ...table(rows));
      return 0;
    }
    case 'view': {
      const a = new Args(argv);
      const pr = findPr(host, ctx, a.rest[0]);
      const bare = bareView(ctx.world, host);
      const baseH = host.branchHash(pr.base);
      const headH = host.branchHash(pr.head);
      const nCommits = baseH && headH ? [...bare.reachable([headH])].filter((h) => !bare.reachable([baseH]).has(h)).length : 0;
      print(
        ctx,
        c.bold(`${pr.title} #${pr.number}`),
        `${stateBadge(pr.state)} • ${pr.author} wants to merge ${nCommits} commit${nCommits === 1 ? '' : 's'} into ${c.cyan(pr.base)} from ${c.cyan(pr.head)} • ${relativeTime(pr.createdAt, now)}`,
        '',
      );
      if (pr.reviews.length) {
        print(ctx, 'Reviewers: ' + pr.reviews.map((r) => `${r.author} (${r.state === 'APPROVED' ? c.green('Approved') : r.state === 'CHANGES_REQUESTED' ? c.red('Changes requested') : 'Commented'})`).join(', '), '');
      }
      print(ctx, ...(pr.body ? pr.body.split('\n').map((l) => `  ${l}`) : [c.gray('  No description provided')]), '');
      for (const cm of [...pr.comments, ...pr.reviews.filter((r) => r.body)]) {
        print(ctx, c.bold(cm.author), ...cm.body.split('\n').map((l) => `  ${l}`), '');
      }
      print(ctx, c.gray(`View this pull request on GitHub: ${host.webUrl}/pull/${pr.number}`));
      return 0;
    }
    case 'status': {
      const branch = repo.currentBranch();
      const mine = host.pulls.filter((p) => p.author === PLAYER_LOGIN && p.state === 'open');
      const cur = host.pulls.find((p) => p.head === branch && p.state === 'open');
      print(ctx, '', `Relevant pull requests in ${host.slug}`, '', c.bold('Current branch'));
      print(ctx, cur ? `  #${cur.number}  ${cur.title} [${cur.head}]` : `  There is no pull request associated with [${branch}]`, '', c.bold('Created by you'));
      if (!mine.length) print(ctx, '  You have no open pull requests');
      for (const p of mine) print(ctx, `  #${p.number}  ${p.title} [${p.head}]`);
      print(ctx, '', c.bold('Requesting a code review from you'), '  You have no pull requests to review');
      return 0;
    }
    case 'checkout':
    case 'co': {
      const pr = findPr(host, ctx, argv[0]);
      await runGit(ctx, ['fetch', 'origin']);
      if (repo.branchHash(pr.head)) return runGit(ctx, ['switch', pr.head]);
      return runGit(ctx, ['switch', '-c', pr.head, `origin/${pr.head}`]);
    }
    case 'diff': {
      const pr = findPr(host, ctx, argv[0]);
      const bare = bareView(ctx.world, host);
      const b = host.branchHash(pr.base)!;
      const h = host.branchHash(pr.head)!;
      const mb = bare.mergeBase(b, h) ?? b;
      print(ctx, ...formatPatch(bare, diffFileMaps(bare.commitFiles(mb), bare.commitFiles(h))));
      return 0;
    }
    case 'merge': {
      const a = new Args(argv);
      const pr = findPr(host, ctx, a.rest[0]);
      const method: MergeMethod | null = a.has('-m', '--merge') ? 'merge' : a.has('-s', '--squash') ? 'squash' : a.has('-r', '--rebase') ? 'rebase' : null;
      if (pr.state !== 'open') throw new GhError([`${c.red('X')} Pull request #${pr.number} (${pr.title}) ${pr.state === 'merged' ? 'was already merged' : "can't be merged because it is closed"}`]);
      if (!method) throw new GhError(['--merge, --rebase, or --squash required when not running interactively']);
      if (a.has('--admin')) {
        ctx.world.emit({ type: 'gh-admin-attempt' });
        throw new GhError([`${c.red('X')} You are not an administrator. This attempt has been logged. (It's always logged.)`]);
      }
      const policy = host.protection.get(pr.base);
      const approvals = pr.reviews.filter((r) => r.state === 'APPROVED').length;
      const changesRequested = pr.reviews.some((r) => r.state === 'CHANGES_REQUESTED');
      if (policy && host.requireApproval && (approvals === 0 || changesRequested)) {
        throw new GhError([
          `${c.red('X')} Pull request #${pr.number} is not mergeable: the base branch policy prohibits the merge.`,
          'To have the pull request merged after all the requirements have been met, add the `--auto` flag.',
          'To use administrator privileges to immediately merge the pull request, add the `--admin` flag.',
        ]);
      }
      if (prConflicts(ctx.world, host, pr).length) {
        throw new GhError([
          `${c.red('X')} Pull request #${pr.number} is not mergeable: the merge commit cannot be cleanly created.`,
          'To have the pull request merged after all the requirements have been met, add the `--auto` flag.',
          c.gray(`(resolve it locally: merge or rebase ${pr.base} into ${pr.head}, fix the conflicts, and push)`),
        ]);
      }
      const me = repo.identity() ?? { name: ctx.world.user, email: `${ctx.world.user}@conglomo.com` };
      const res = mergePullRequest(ctx.world, host, pr, method, me);
      if (!res.ok) throw new GhError([`${c.red('X')} Pull request #${pr.number} is not mergeable: ${res.reason}.`]);
      const verb = method === 'merge' ? 'Merged' : method === 'squash' ? 'Squashed and merged' : 'Rebased and merged';
      print(ctx, `${c.magenta('✓')} ${verb} pull request #${pr.number} (${pr.title})`);
      ctx.world.emit({ type: 'pr-merge', number: pr.number, method, head: pr.head, base: pr.base });

      if (a.has('-d', '--delete-branch')) {
        host.refs.delete(`refs/heads/${pr.head}`);
        const cur = repo.currentBranch();
        const sub = { ...ctx, out: [] as string[] };
        if (cur === pr.head) {
          if (repo.branchHash(pr.base)) await runGit(sub, ['switch', pr.base]);
          else await runGit(sub, ['switch', '-c', pr.base, `origin/${pr.base}`]);
        }
        await runGit(sub, ['pull', '--ff-only', 'origin', pr.base]);
        const delSub = { ...ctx, out: [] as string[] };
        if (repo.branchHash(pr.head)) await runGit(delSub, ['branch', '-D', pr.head]);
        await runGit({ ...ctx, out: [] }, ['fetch', '--prune', 'origin']);
        print(ctx, `${c.red('✓')} Deleted local branch ${c.cyan(pr.head)} and switched to branch ${c.cyan(repo.currentBranch() ?? pr.base)}`);
        print(ctx, `${c.red('✓')} Deleted remote branch ${c.cyan(pr.head)}`);
      }
      void sh;
      return 0;
    }
    case 'close': {
      const pr = findPr(host, ctx, argv[0]);
      pr.state = 'closed';
      print(ctx, `${c.red('✓')} Closed pull request #${pr.number} (${pr.title})`);
      ctx.world.emit({ type: 'pr-close', number: pr.number });
      return 0;
    }
    case 'reopen': {
      const pr = findPr(host, ctx, argv[0]);
      if (pr.state === 'merged') throw new GhError([`Pull request #${pr.number} can't be reopened because it was already merged`]);
      pr.state = 'open';
      print(ctx, `${c.green('✓')} Reopened pull request #${pr.number} (${pr.title})`);
      return 0;
    }
    case 'comment': {
      const a = new Args(argv, ['-b', '--body']);
      const pr = findPr(host, ctx, a.rest[0]);
      const body = a.value('-b', '--body');
      if (!body) throw new GhError(['--body required when not running interactively']);
      pr.comments.push({ author: PLAYER_LOGIN, body });
      print(ctx, `${host.webUrl}/pull/${pr.number}#issuecomment-${1000 + pr.comments.length}`);
      ctx.world.emit({ type: 'pr-comment', number: pr.number, body });
      return 0;
    }
    case 'review': {
      const a = new Args(argv, ['-b', '--body']);
      const pr = findPr(host, ctx, a.rest[0]);
      if (a.has('-a', '--approve') && pr.author === PLAYER_LOGIN) {
        throw new GhError(['failed to create review: GraphQL: Can not approve your own pull request (addPullRequestReview)']);
      }
      const state = a.has('-a', '--approve') ? 'APPROVED' : a.has('-r', '--request-changes') ? 'CHANGES_REQUESTED' : 'COMMENTED';
      pr.reviews.push({ author: PLAYER_LOGIN, state, body: a.value('-b', '--body') ?? '' });
      print(ctx, `${c.green('✓')} ${state === 'APPROVED' ? 'Approved' : state === 'CHANGES_REQUESTED' ? 'Requested changes to' : 'Reviewed'} pull request #${pr.number}`);
      ctx.world.emit({ type: 'pr-review', number: pr.number, state });
      return 0;
    }
    default:
      throw new GhError([
        'Work with GitHub pull requests.',
        '',
        c.bold('USAGE'),
        '  gh pr <command> [flags]',
        '',
        c.bold('COMMANDS'),
        '  checkout:   Check out a pull request in git',
        '  close:      Close a pull request',
        '  comment:    Add a comment to a pull request',
        '  create:     Create a pull request',
        '  diff:       View changes in a pull request',
        '  list:       List pull requests in a repository',
        '  merge:      Merge a pull request',
        '  reopen:     Reopen a pull request',
        '  review:     Add a review to a pull request',
        '  status:     Show status of relevant pull requests',
        '  view:       View a pull request',
      ], sub ? 1 : 0);
  }
}

function issueCommand(ctx: GitContext, sub: string, argv: string[]): number {
  const host = resolveHost(ctx);
  const now = ctx.world.clock.now();
  const find = (arg: string | undefined) => {
    const n = parseInt((arg ?? '').replace(/^#/, ''), 10);
    const issue = host.issue(n);
    if (!issue) throw new GhError([`GraphQL: Could not resolve to an issue or pull request with the number of ${arg}. (repository.issue)`]);
    return issue;
  };
  switch (sub) {
    case 'list': {
      const a = new Args(argv, ['-s', '--state', '-l', '--label', '-a', '--assignee', '-A', '--author']);
      const state = a.value('-s', '--state') ?? 'open';
      const label = a.value('-l', '--label');
      let list = host.issues.filter((i) => state === 'all' || i.state === state);
      if (label) list = list.filter((i) => i.labels.includes(label));
      const assignee = a.value('-a', '--assignee');
      if (assignee) list = list.filter((i) => i.assignees.includes(assignee === '@me' ? PLAYER_LOGIN : assignee));
      list.sort((x, y) => y.number - x.number);
      if (!list.length) {
        print(ctx, '', `no ${state === 'all' ? '' : state + ' '}issues match your search in ${host.slug}`);
        return 0;
      }
      print(ctx, '', `Showing ${list.length} of ${list.length} ${state === 'all' ? '' : state + ' '}issue${list.length === 1 ? '' : 's'} in ${host.slug}`, '');
      const rows = [[c.bold('ID'), c.bold('TITLE'), c.bold('LABELS'), c.bold('UPDATED')]];
      for (const i of list) rows.push([i.state === 'open' ? c.green(`#${i.number}`) : c.magenta(`#${i.number}`), i.title, c.yellow(i.labels.join(', ')), relativeTime(i.createdAt, now).replace(/^(\d)/, 'about $1')]);
      print(ctx, ...table(rows));
      return 0;
    }
    case 'view': {
      const i = find(argv[0]);
      print(
        ctx,
        c.bold(`${i.title} #${i.number}`),
        `${i.state === 'open' ? c.green('Open') : c.magenta('Closed')} • ${i.author} opened ${relativeTime(i.createdAt, now)} • ${i.comments.length} comment${i.comments.length === 1 ? '' : 's'}`,
        ...(i.labels.length ? [`Labels: ${c.yellow(i.labels.join(', '))}`] : []),
        ...(i.assignees.length ? [`Assignees: ${i.assignees.join(', ')}`] : []),
        '',
        ...i.body.split('\n').map((l) => `  ${l}`),
        '',
      );
      for (const cm of i.comments) print(ctx, c.bold(cm.author), ...cm.body.split('\n').map((l) => `  ${l}`), '');
      print(ctx, c.gray(`View this issue on GitHub: ${host.webUrl}/issues/${i.number}`));
      return 0;
    }
    case 'create': {
      const a = new Args(argv, ['-t', '--title', '-b', '--body', '-l', '--label', '-a', '--assignee']);
      const title = a.value('-t', '--title');
      const body = a.value('-b', '--body');
      if (!title || body === undefined) throw new GhError(['must provide `--title` and `--body` when not running interactively']);
      const issue = host.openIssue({ title, body, author: PLAYER_LOGIN, createdAt: now, labels: a.values('-l', '--label') });
      print(ctx, '', `Creating issue in ${host.slug}`, '', `${host.webUrl}/issues/${issue.number}`);
      ctx.world.emit({ type: 'issue-create', number: issue.number, title });
      return 0;
    }
    case 'close': {
      const a = new Args(argv, ['-c', '--comment', '-r', '--reason']);
      const i = find(a.rest[0]);
      if (i.state === 'closed') {
        print(ctx, `${c.yellow('!')} Issue #${i.number} (${i.title}) is already closed`);
        return 0;
      }
      const comment = a.value('-c', '--comment');
      if (comment) i.comments.push({ author: PLAYER_LOGIN, body: comment });
      i.state = 'closed';
      i.closedBy = PLAYER_LOGIN;
      print(ctx, `${c.red('✓')} Closed issue #${i.number} (${i.title})`);
      ctx.world.emit({ type: 'issue-close', number: i.number, comment, reason: a.value('-r', '--reason') });
      return 0;
    }
    case 'reopen': {
      const i = find(argv[0]);
      i.state = 'open';
      print(ctx, `${c.green('✓')} Reopened issue #${i.number} (${i.title})`);
      return 0;
    }
    case 'comment': {
      const a = new Args(argv, ['-b', '--body']);
      const i = find(a.rest[0]);
      const body = a.value('-b', '--body');
      if (!body) throw new GhError(['--body required when not running interactively']);
      i.comments.push({ author: PLAYER_LOGIN, body });
      print(ctx, `${host.webUrl}/issues/${i.number}#issuecomment-${2000 + i.comments.length}`);
      ctx.world.emit({ type: 'issue-comment', number: i.number, body });
      return 0;
    }
    default:
      throw new GhError([
        'Work with GitHub issues.',
        '',
        c.bold('USAGE'),
        '  gh issue <command> [flags]',
        '',
        c.bold('COMMANDS'),
        '  close:      Close issue',
        '  comment:    Add a comment to an issue',
        '  create:     Create a new issue',
        '  list:       List issues in a repository',
        '  reopen:     Reopen issue',
        '  view:       View an issue',
      ], sub ? 1 : 0);
  }
}

export async function runGh(ctx: GitContext, argv: string[], sh: Shell): Promise<number> {
  const [group, sub, ...rest] = argv;
  try {
    switch (group) {
      case 'pr':
        return await prCommand(ctx, sh, sub ?? '', rest);
      case 'issue':
        return issueCommand(ctx, sub ?? '', rest);
      case 'repo': {
        const host = resolveHost(ctx);
        if (sub === 'view' || !sub) {
          const bare = bareView(ctx.world, host);
          const h = host.branchHash(host.defaultBranch);
          const readme = h ? bare.commitFiles(h).get('README.md') : undefined;
          print(ctx, c.bold(host.slug), host.description || c.gray('No description provided'), '', ...(readme ? bare.blob(readme).split('\n').map((l) => `  ${l}`) : []), c.gray(`View this repository on GitHub: ${host.webUrl}`));
          return 0;
        }
        if (sub === 'clone') return runGit(ctx, ['clone', `git@github.com:${rest[0]}.git`, ...rest.slice(1)]);
        throw new GhError([`unknown command "${sub}" for "gh repo"`]);
      }
      case 'auth':
        print(
          ctx,
          'github.com',
          `  ${c.green('✓')} Logged in to github.com account ${PLAYER_LOGIN} (keyring)`,
          '  - Active account: true',
          "  - Git operations protocol: ssh",
          "  - Token scopes: 'repo', 'read:org' (admin scopes pending approval since March)",
        );
        return 0;
      case 'browse':
        print(ctx, `Opening ${resolveHost(ctx).webUrl} in your browser.`, c.gray('(Browser blocked by IT policy. Use gh pr view / gh issue view instead.)'));
        return 0;
      case '--version':
      case 'version':
        print(ctx, 'gh version 2.40.1 (2023-12-13)');
        return 0;
      default:
        print(
          ctx,
          'Work seamlessly with GitHub from the command line.',
          '',
          c.bold('USAGE'),
          '  gh <command> <subcommand> [flags]',
          '',
          c.bold('CORE COMMANDS'),
          '  auth:        Authenticate gh and git with GitHub',
          '  browse:      Open the repository in the browser',
          '  issue:       Manage issues',
          '  pr:          Manage pull requests',
          '  repo:        Manage repositories',
        );
        return group ? 1 : 0;
    }
  } catch (e) {
    if (e instanceof GhError) {
      print(ctx, ...e.lines);
      return e.code;
    }
    throw e;
  }
}

export function GH_COMPLETIONS(words: string[]): string[] {
  if (words.length === 0) return ['pr', 'issue', 'repo', 'auth', 'browse'];
  if (words[0] === 'pr' && words.length === 1) return ['create', 'list', 'view', 'status', 'checkout', 'diff', 'merge', 'close', 'reopen', 'comment', 'review'];
  if (words[0] === 'issue' && words.length === 1) return ['list', 'view', 'create', 'close', 'reopen', 'comment'];
  if (words[0] === 'repo' && words.length === 1) return ['view', 'clone'];
  if (words[0] === 'pr' && words[1] === 'create') return ['--title', '--body', '--base', '--fill', '--draft'];
  if (words[0] === 'pr' && words[1] === 'merge') return ['--merge', '--squash', '--rebase', '--delete-branch'];
  return [];
}
