import { AUTHORS } from '../characters';
import type { Level } from '../types';

export const level11: Level = {
  id: 'reflog',
  ticket: 'CONG-1011',
  title: 'The Intern Force-Pushed',
  clock: '2026-03-04 14:58',
  summary: 'Recover commits that vanished from both GitHub and your machine, using the reflog.',
  concepts: ['git reflog', 'HEAD@{n}', 'recovering lost commits', 'fast-forward push'],
  repo: 'inventory-service',
  hosted: 'conglomo/inventory-service',

  async setup(b) {
    b.at('2026-02-23 10:00');
    const h = b.hub('conglomo', 'inventory-service', { description: 'Counts things. Occasionally correctly.' });
    const base = h.commit('main', { 'stock.js': 'export const stock = new Map();\n', 'README.md': '# inventory-service\n' }, 'Inventory service', AUTHORS.greg);
    b.at('2026-03-03 10:00');
    const c1 = h.commit('main', { 'reserve.js': 'export function reserve(sku, n) { /* locks rows */ }\n' }, 'Add stock reservations', AUTHORS.greg);
    const c2 = h.commit('main', { 'alerts.js': 'export const LOW_STOCK = 5;\n' }, 'Alert when stock runs low', AUTHORS.priya);
    const c3 = h.commit('main', { 'reserve.js': 'export function reserve(sku, n) { /* locks rows, with timeout */ }\n' }, 'Add timeout to reservations', AUTHORS.greg);
    Object.assign(b.world.data, { c1, c2, c3 });
    b.clone(h);
    // Todd, from an old checkout: `git push --force origin HEAD:main`.
    b.at('2026-03-04 11:02');
    h.forceBranch('main', base);
    h.host.events.push({ kind: 'push', repo: h.host.slug, ref: 'refs/heads/main', old: c3, new: base, forced: true, by: 'Todd Brennan' });
    // ...and then you followed Todd's advice to "fix" your local copy.
    await b.run('inventory-service', 'git fetch', 'git reset --hard origin/main');
    b.cwd('inventory-service');
  },

  intro: [
    { from: 'priya', text: 'why does `main` on github look like it\'s from last week.' },
    {
      from: 'todd',
      text: 'ok so. funny story. i meant to push my branch but i think i pushed my OLD main?? with --force?? and then i told everyone to run `git reset --hard origin/main` to “fix it” 😬',
    },
    { from: 'greg', text: 'and you did. i watched you do it. three commits are gone from github AND from your machine. two of mine, one of priya\'s.' },
    { from: 'greg', text: 'they\'re not actually gone. git remembers everywhere HEAD has been. `git reflog`. find them, put main back, push. no force needed if you do it right.' },
    { from: 'dana', text: 'No pressure, but the inventory release is at 4. 🙂' },
  ],

  objectives: [
    {
      id: 'recover',
      text: 'Recover the three lost commits on your local main',
      check: (p) => {
        const r = p.repo;
        const tip = p.rev('main');
        return !!r && !!tip && [p.data.c1, p.data.c2, p.data.c3].every((h) => r.isAncestor(h, tip));
      },
    },
    {
      id: 'restore',
      text: 'Restore them on GitHub\'s main',
      check: (p) => [p.data.c1, p.data.c2, p.data.c3].every((h) => p.remoteCommits('main').has(h)),
    },
  ],

  hints: [
    '`git reflog` lists every position HEAD has been in. Find the entry just *before* “reset: moving to origin/main”.',
    '`git reset --hard HEAD@{1}` moves main back to where it was before that reset. Check `git log --oneline`: you should see Greg\'s and Priya\'s commits again.',
    '`git push`. GitHub\'s main is an ancestor of your recovered main, so it\'s an ordinary fast-forward. No force needed.',
  ],

  reactions: [
    {
      id: 'reflog-seen',
      when: (r) => /^git reflog/.test(r.command) && r.code === 0,
      say: [{ from: 'greg', text: 'see the entry before “reset: moving to origin/main”? that\'s where main was before todd\'s advice ruined your morning.' }],
    },
    {
      id: 'recovered',
      when: (r) => {
        const repo = r.probe.repo;
        const tip = r.probe.rev('main');
        return !!repo && !!tip && repo.isAncestor(r.probe.data.c3, tip);
      },
      say: [{ from: 'priya', text: 'my commit is back in your `git log`. i can breathe again. now push it before anything else happens.' }],
    },
  ],

  outro: [
    { from: 'priya', text: 'github is back to normal. all three commits. the release is saved.' },
    { from: 'greg', text: 'and nobody had to force push to fix a force push. growth.' },
    { from: 'todd', text: 'i have been removed from the list of people who can push to main. understandable. deserved even.' },
  ],

  debrief: {
    title: 'The reflog: git\'s undo history',
    points: [
      'The reflog is a local journal of every commit HEAD (and each branch) has pointed to: commits, checkouts, resets, rebases, merges.',
      'Commits no branch points to aren\'t deleted right away. They\'re only garbage-collected after weeks, and the reflog is how you find them again.',
      '`HEAD@{n}` means “where HEAD was n moves ago”. `git reset --hard HEAD@{1}` undoes your last move; `git branch rescue <hash>` saves a lost commit under a new name.',
      'The reflog is per-machine. It isn\'t pushed or shared. Your laptop remembered what GitHub forgot.',
    ],
  },

  solution: ['git reflog', 'git reset --hard HEAD@{1}', 'git push'],
  par: 2,
};
