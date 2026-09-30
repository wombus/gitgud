import { hasConflictMarkers } from '../../engine/diff';
import { AUTHORS } from '../characters';
import type { Level } from '../types';

const BRANCH = 'feature/push-notifications';

const ROUTES_BASE = `export const routes = [
  '/health',
  '/users',
  '/orders',
];
`;
const ROUTES_PRIYA = ROUTES_BASE.replace("  '/orders',\n", "  '/orders',\n  '/metrics',\n");
const ROUTES_MINE = ROUTES_BASE.replace("  '/orders',\n", "  '/orders',\n  '/notifications',\n");
export const ROUTES_RESOLVED = ROUTES_BASE.replace("  '/orders',\n", "  '/orders',\n  '/metrics',\n  '/notifications',\n");

function routesOk(content: string | undefined): boolean {
  if (!content || hasConflictMarkers(content)) return false;
  const count = (s: string) => content.split(s).length - 1;
  return count("'/metrics'") === 1 && count("'/notifications'") === 1 && count("'/orders'") === 1 && count("'/health'") === 1;
}

export const level09: Level = {
  id: 'rebase',
  ticket: 'CONG-1009',
  title: 'Keep It Linear',
  clock: '2026-03-04 09:55',
  summary: 'Rebase a feature branch onto main, resolve a conflict mid-rebase, and force-push safely.',
  concepts: ['git rebase', 'rebase --continue', 'linear history', 'push --force-with-lease'],
  repo: 'mobile-api',
  hosted: 'conglomo/mobile-api',

  async setup(b) {
    b.at('2026-02-16 10:00');
    const h = b.hub('conglomo', 'mobile-api', { description: 'The API behind the app with 2.1 stars' });
    h.commit('main', { 'routes.js': ROUTES_BASE, 'server.js': 'import { routes } from "./routes.js";\n' }, 'Mobile API skeleton', AUTHORS.greg);
    h.protect('main');
    b.clone(h);
    b.at('2026-03-03 15:00');
    await b.run('mobile-api', `git switch -c ${BRANCH}`);
    b.write('mobile-api', { 'notifications.js': 'export function notify(user, msg) {\n  return `🔔 ${user}: ${msg}`;\n}\n' });
    await b.run('mobile-api', 'git add notifications.js', 'git commit -m "Add notification helper"');
    b.write('mobile-api', { 'routes.js': ROUTES_MINE });
    await b.run('mobile-api', 'git commit -am "Expose /notifications route"', `git push -u origin ${BRANCH}`);
    b.at('2026-03-03 17:30');
    h.commit('main', { 'routes.js': ROUTES_PRIYA }, 'Expose /metrics for monitoring', AUTHORS.priya, { minutes: 1 });
    b.world.data.mainTip = h.commit('main', { 'server.js': 'import { routes } from "./routes.js";\n// TODO(greg): rate limiting\n' }, 'Note about rate limiting', AUTHORS.greg);
    b.cwd('mobile-api');
  },

  intro: [
    { from: 'dana', text: 'Your push-notifications PR is behind `main`. Team policy: feature branches get *rebased*, not merged. We like our history linear. 📏' },
    { from: 'greg', text: 'fetch first. then `git rebase origin/main`. you\'ll hit a conflict in routes.js because priya added /metrics. keep both routes.' },
    { from: 'priya', text: 'i did add /metrics. i will not be apologizing.', delay: 600 },
    {
      from: 'greg',
      text: 'after a rebase your commits have new hashes, so github will reject a normal push. use `git push --force-with-lease`. NOT --force. there\'s a difference and i will explain it at length if asked.',
    },
  ],

  objectives: [
    {
      id: 'rebased',
      text: `Rebase ${BRANCH} onto the latest main (no merge commits)`,
      check: (p) => {
        const r = p.repo;
        const tip = p.rev(BRANCH);
        if (!r || !tip || !r.objects.has(p.data.mainTip) || !r.isAncestor(p.data.mainTip, tip)) return false;
        return p.range(p.data.mainTip, BRANCH).every((h) => r.parents(h).length === 1);
      },
    },
    {
      id: 'resolved',
      text: 'routes.js keeps both /metrics and /notifications',
      check: (p) => p.noConflicts() && routesOk(p.fileAt(BRANCH, 'routes.js')) && p.fileAt(BRANCH, 'notifications.js') !== undefined,
    },
    {
      id: 'pushed',
      text: 'Update the remote branch (safely)',
      check: (p) => p.pushed(BRANCH) && routesOk(p.remoteFile(BRANCH, 'routes.js')),
    },
  ],

  hints: [
    '`git fetch`, then `git rebase origin/main`. Git replays your two commits on top of the new main, one at a time.',
    'At the conflict: `nano routes.js`, keep both `\'/metrics\',` and `\'/notifications\',`, delete the markers. Then `git add routes.js` and `git rebase --continue`.',
    'Lost mid-rebase? `git status` explains where you are, and `git rebase --abort` puts everything back.',
    'Finally `git push --force-with-lease`. It refuses to overwrite the remote branch if someone else pushed to it since your last fetch.',
  ],

  reactions: [
    {
      id: 'merge-commit',
      when: (r) => r.events.some((e) => e.type === 'merge' && e.kind === 'true'),
      say: [{ from: 'dana', text: 'Looks like a merge commit snuck in! Our policy is linear history. `git reset --hard ORIG_HEAD` undoes the merge, then rebase instead. 🙂' }],
    },
    {
      id: 'mid-rebase',
      when: (r) => r.events.some((e) => e.type === 'rebase' && e.stage === 'conflict'),
      say: [{ from: 'todd', text: 'your prompt says REBASE 2/2 now!! that means it\'s on your 2nd commit. fix the file, `git add` it, then `git rebase --continue` 🚀' }],
    },
    {
      id: 'rejected',
      when: (r) => r.events.some((e) => e.type === 'push-rejected'),
      say: [{ from: 'greg', text: 'rejected, as foretold. your branch was rewritten, so it\'s no longer a fast-forward of the remote. `--force-with-lease`.' }],
    },
    {
      id: 'lease',
      when: (r) => /--force-with-lease/.test(r.command) && r.events.some((e) => e.type === 'push' && e.forced),
      say: [{ from: 'greg', text: '--force-with-lease. look at you. civilized.' }],
    },
  ],

  fails: [
    {
      id: 'force-main',
      check: (r) =>
        r.probe.forcePushed('main')
          ? { from: 'greg', title: 'Main Rewritten', body: 'You force-pushed `main`. Rebasing a *shared* branch rewrites everyone\'s history. The rule is: rebase your own branches, never the one everyone builds on.' }
          : null,
    },
  ],

  outro: [
    { from: 'system', text: '🔔 PR #31 “Push notifications”: This branch is up to date with the base branch.' },
    { from: 'greg', text: 'linear. beautiful. `git log --graph` looks like a straight line. like my blood pressure should.' },
    { from: 'dana', text: 'Lovely clean history! 🧼' },
  ],

  debrief: {
    title: 'Rebase',
    points: [
      '`git rebase <base>` takes the commits unique to your branch and replays them, one by one, on top of <base>. The result looks as if you\'d started your work from the latest main.',
      'Replayed commits are *new* commits with new hashes, so your branch no longer matches its remote copy. That\'s why a force push is needed afterwards.',
      '`--force-with-lease` only overwrites the remote branch if it still points where you last saw it. Plain `--force` overwrites unconditionally, including a teammate\'s fresh push.',
      'The golden rule: rebase your own unshared work freely; never rebase commits others have already built on (like main or a release branch).',
    ],
  },

  solution: ['git fetch', 'git rebase origin/main', 'nano routes.js', 'git add routes.js', 'git rebase --continue', 'git push --force-with-lease'],
  solutionEdits: { 'routes.js': () => ROUTES_RESOLVED },
  par: 6,
};
