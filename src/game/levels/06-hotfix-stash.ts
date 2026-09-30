import { AUTHORS } from '../characters';
import type { Probe } from '../probe';
import type { Level } from '../types';

const LOGIN_BROKEN = `// Login handler. Do not touch. — Greg, 2019
export function checkPassword(user, input) {
  if (!user) return false;
  if (user.password = input) {
    return true;
  }
  return false;
}
`;
export const LOGIN_FIXED = LOGIN_BROKEN.replace('user.password = input', 'user.password === input');

const REPORTS_BASE = `export function monthlyReport(rows) {
  return rows.length + ' rows';
}
`;
const REPORTS_WIP = `import { drawChart } from './charts.js';

export function monthlyReport(rows) {
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  // TODO: ask Dana what "make it pop" means
  return drawChart(rows, { title: 'Monthly Revenue', total });
}
`;
const CHARTS_WIP = `export function drawChart(rows, opts) {
  // three days of work. do not lose this.
  return rows.map((r) => '█'.repeat(Math.round(r.amount / 100))).join('\\n') + '\\n' + opts.title;
}
`;

/** Is the WIP still recoverable anywhere (worktree, stash, or any commit git can still reach)? */
function wipExists(p: Probe): boolean {
  const r = p.repo;
  if (!r) return false;
  if (r.worktree.get('reports.js') === REPORTS_WIP) return true;
  const tips = [...r.allRefTips()];
  for (const log of r.reflogs.values()) for (const e of log) if (r.objects.isCommit(e.new)) tips.push(e.new);
  for (const h of r.reachable(tips)) {
    const f = r.commitFiles(h).get('reports.js');
    if (f && r.blob(f) === REPORTS_WIP) return true;
  }
  return false;
}

export const level06: Level = {
  id: 'hotfix-stash',
  ticket: 'CONG-1006',
  title: 'Drop Everything',
  clock: '2026-03-03 10:22',
  summary: 'Shelve work-in-progress with stash, hotfix main, and get your work back.',
  concepts: ['git stash -u', 'git stash pop', 'context switching', 'hotfixes'],
  repo: 'checkout-app',
  hosted: 'conglomo/checkout-app',

  async setup(b) {
    b.at('2026-02-20 09:00');
    const h = b.hub('conglomo', 'checkout-app', { description: 'Where customers give us money' });
    h.commit('main', { 'login.js': LOGIN_FIXED, 'reports.js': REPORTS_BASE, 'README.md': '# checkout-app\n' }, 'Initial checkout app', AUTHORS.greg);
    h.branch('feature/reports', 'main');
    b.at('2026-02-27 16:40');
    h.commit('main', { 'login.js': LOGIN_BROKEN }, 'Simplify password check', AUTHORS.todd);
    b.clone(h);
    await b.run('checkout-app', 'git switch feature/reports');
    b.write('checkout-app', { 'reports.js': REPORTS_WIP, 'charts.js': CHARTS_WIP });
    // Someone else fixed a typo in the README on main since you cloned.
    h.commit('main', { 'README.md': '# checkout-app\n\nOn-call: Priya. Always Priya.\n' }, 'Update README with on-call info', AUTHORS.priya, { minutes: 60 * 17 });
    b.cwd('checkout-app');
  },

  intro: [
    { from: 'priya', text: '🚨 SEV-1. anyone can log in as anyone. in prod. right now.' },
    { from: 'priya', text: 'line 4 of `login.js` on main: `if (user.password = input)`. that\'s an assignment. it\'s always truthy. it needs `===`.' },
    { from: 'todd', text: 'that was me. i "simplified" it. 😭', delay: 700 },
    { from: 'dana', text: 'Can you drop everything and hotfix `main`? Branch protection is temporarily off so you can push straight to main. This is fine. 🔥🙂' },
    {
      from: 'greg',
      text: 'you have three days of uncommitted work on feature/reports. don\'t lose it. don\'t commit it to main either. `git stash` exists for exactly this moment.',
    },
  ],

  objectives: [
    {
      id: 'shelve',
      text: 'Get to main without losing (or committing) your reports WIP',
      check: (p) => p.happened('checkout', (e) => e.branch === 'main') && wipExists(p),
    },
    {
      id: 'fix',
      text: 'Fix login.js (= → ===) on main and push it',
      check: (p) => p.remoteFile('main', 'login.js') === LOGIN_FIXED,
    },
    {
      id: 'clean-fix',
      text: 'The hotfix contains only the fix (no reports WIP)',
      check: (p) =>
        p.remoteFile('main', 'login.js') === LOGIN_FIXED &&
        !p.remoteHistoryContains('main', 'charts.js') &&
        p.remoteFile('main', 'reports.js') === REPORTS_BASE,
    },
    {
      id: 'restore',
      text: 'Back on feature/reports with your WIP restored, stash empty',
      check: (p) =>
        p.branch() === 'feature/reports' && p.file('reports.js') === REPORTS_WIP && p.file('charts.js') === CHARTS_WIP && p.repo!.stash.length === 0,
    },
  ],

  hints: [
    '`git stash -u` shelves your uncommitted changes (`-u` includes untracked files like charts.js) and leaves a clean working tree.',
    '`git switch main`, then `git pull` (main has moved since you cloned), then fix line 4 with `nano login.js`.',
    '`git commit -am "Fix password comparison in login"` then `git push`.',
    'Back to work: `git switch feature/reports`, then `git stash pop` (pop re-applies the stash *and* removes it).',
  ],

  reactions: [
    {
      id: 'charts-followed',
      when: (r) => r.probe.branch() === 'main' && r.probe.file('charts.js') === CHARTS_WIP && !r.probe.repo?.isTracked('charts.js'),
      say: [{ from: 'greg', text: 'psst. charts.js followed you to main. untracked files don\'t get stashed without `-u`. don\'t `git add .` in here.' }],
    },
    {
      id: 'rejected',
      when: (r) => r.events.some((e) => e.type === 'push-rejected'),
      say: [{ from: 'priya', text: 'rejected: main moved since you last pulled (i updated the README). `git pull`, then push. quickly. please. 🙏' }],
    },
    {
      id: 'deployed',
      when: (r) => r.probe.remoteFile('main', 'login.js') === LOGIN_FIXED,
      say: [
        { from: 'priya', text: 'deployed. logins require the correct password again. civilization restored. 🫡' },
        { from: 'greg', text: 'now go get your stash back before you forget it exists. everyone forgets it exists.', delay: 900 },
      ],
    },
    {
      id: 'applied-not-popped',
      when: (r) => /git stash apply/.test(r.command) && r.code === 0,
      say: [{ from: 'todd', text: '`apply` keeps the stash around btw! `git stash drop` gets rid of it (or use `pop` next time, it does both)' }],
    },
  ],

  fails: [
    {
      id: 'wip-lost',
      check: (r) =>
        wipExists(r.probe)
          ? null
          : {
              from: 'dana',
              title: 'Work-in-Progress Destroyed',
              body:
                'Three days of work on the monthly reports feature were discarded (or its stash was dropped) before being restored. ' +
                'Todd has kindly offered to help rewrite it. From memory. Nobody has accepted his offer.',
            },
    },
    {
      id: 'wip-shipped',
      check: (r) =>
        r.probe.remoteHistoryContains('main', 'charts.js') || (r.probe.remoteFile('main', 'reports.js') ?? REPORTS_BASE) !== REPORTS_BASE
          ? {
              from: 'priya',
              title: 'Unreviewed Code Deployed to Production',
              body:
                'Your half-finished reports feature rode along with the hotfix straight into prod. The dashboard now renders revenue as a histogram of block characters titled "make it pop". ' +
                'Customers are screenshotting it.',
            }
          : null,
    },
  ],

  outro: [
    { from: 'dana', text: 'Prod is safe AND your reports work survived. That\'s a rare double. 🏆' },
    { from: 'todd', text: 'i\'ve been banned from "simplifying" things. fair.' },
  ],

  debrief: {
    title: 'Stashing',
    points: [
      '`git stash` saves your uncommitted changes (staged and unstaged) as a special commit, then resets your working tree to HEAD so you can switch context safely.',
      'Untracked files are left alone unless you add `-u` (`--include-untracked`). Otherwise they tag along to whatever branch you switch to.',
      '`git stash pop` re-applies the newest stash and drops it; `git stash apply` re-applies but keeps it. `git stash list` shows what\'s shelved.',
      'Stashes are local and easy to forget. For anything longer than a quick interruption, a WIP commit on your own branch is often safer.',
    ],
  },

  solution: [
    'git stash -u',
    'git switch main',
    'git pull',
    'nano login.js',
    'git commit -am "Fix password comparison in login"',
    'git push',
    'git switch feature/reports',
    'git stash pop',
  ],
  solutionEdits: { 'login.js': () => LOGIN_FIXED },
  par: 8,
};
