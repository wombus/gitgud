import { AUTHORS } from '../characters';
import type { Level } from '../types';

const MONEY_GOOD = `// All money is in dollars. Floats. Yes, we know. There's a ticket.
export function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}

export function applyTax(amount, rate) {
  return roundCents(amount * (1 + rate));
}
`;
const MONEY_TODD = MONEY_GOOD.replace('return Math.round(amount * 100) / 100;', 'return Math.floor(amount); // simpler!!');

const RETRY_BASE = `export const RETRY = { attempts: 3, backoffMs: 200 };\n`;
const RETRY_GREG = `export const RETRY = { attempts: 3, backoffMs: 200, jitter: true };\n`;

export const level07: Level = {
  id: 'revert',
  ticket: 'CONG-1007',
  title: 'Undo! Undo!',
  clock: '2026-03-03 14:07',
  summary: 'Undo a bad commit on a shared branch without rewriting history.',
  concepts: ['git revert', 'git reset vs revert', 'shared history', 'force push'],
  repo: 'payments-service',
  hosted: 'conglomo/payments-service',

  setup(b) {
    b.at('2026-02-02 10:00');
    const h = b.hub('conglomo', 'payments-service', { description: 'Takes money. Mostly correctly.' });
    h.commit('main', { 'money.js': MONEY_GOOD, 'retry.js': RETRY_BASE, 'README.md': '# payments-service\n' }, 'Initial payments service', AUTHORS.greg);
    b.at('2026-03-03 09:12');
    b.world.data.todd = h.commit('main', { 'money.js': MONEY_TODD }, 'Refactor rounding (trust me)', AUTHORS.todd);
    b.world.data.greg = h.commit('main', { 'retry.js': RETRY_GREG }, 'Add jitter to payment retries', AUTHORS.greg);
    b.world.data.dana = h.commit('main', { 'README.md': '# payments-service\n\n![build](passing) ![coverage](we don\'t talk about coverage)\n' }, 'Add README badges', AUTHORS.dana);
    // Greg turned protection off because it "slowed him down".
    b.clone(h);
    b.cwd('payments-service');
  },

  intro: [
    { from: 'priya', text: 'checkout is charging $19.99 items as $19. finance noticed. finance always notices.' },
    { from: 'greg', text: 'it\'s todd\'s commit. “Refactor rounding (trust me)”. i did not trust him. i was right.' },
    { from: 'todd', text: 'Math.floor seemed simpler??? 😭', delay: 500 },
    {
      from: 'dana',
      text: 'Please undo Todd\'s commit on `main`. Important: 14 people have already pulled main, so do NOT rewrite its history. We need a new commit that undoes it.',
    },
    { from: 'greg', text: 'fyi i turned off branch protection on this repo because it slowed me down. so nothing will stop you from doing something dumb. don\'t.' },
  ],

  objectives: [
    {
      id: 'undo',
      text: 'Undo Todd\'s rounding change on your main',
      check: (p) => p.fileAt('main', 'money.js') === MONEY_GOOD && p.fileAt('main', 'retry.js') === RETRY_GREG,
    },
    {
      id: 'history',
      text: 'Keep history intact (Todd\'s, Greg\'s and Dana\'s commits stay)',
      check: (p) => {
        const r = p.repo;
        const tip = p.rev('main');
        return !!r && !!tip && p.fileAt('main', 'money.js') === MONEY_GOOD && [p.data.todd, p.data.greg, p.data.dana].every((h) => r.isAncestor(h, tip));
      },
    },
    {
      id: 'push',
      text: 'Push the fix to GitHub',
      check: (p) => p.remoteFile('main', 'money.js') === MONEY_GOOD && p.remoteFile('main', 'retry.js') === RETRY_GREG && p.remoteCommits('main').has(p.data.dana),
    },
  ],

  hints: [
    'Find the culprit: `git log --oneline` (look for “Refactor rounding”). `git show <hash>` shows exactly what it changed.',
    '`git revert <hash>` creates a *new* commit applying the exact inverse of that commit. Nothing is rewritten. (It\'s HEAD~2 here.)',
    'Then `git push`. A revert is just another commit, so the push is an ordinary fast-forward.',
  ],

  reactions: [
    {
      id: 'reset-local',
      when: (r) => r.events.some((e) => e.type === 'reset' && e.mode === 'hard' && e.branch === 'main') && !r.probe.repo?.isAncestor(r.probe.data.dana, r.probe.rev('main')!),
      say: [
        {
          from: 'greg',
          text: 'you just reset main locally. that threw away my commit and dana\'s too, not just todd\'s. it\'s only local so far. `git reset --hard origin/main` puts it back.',
        },
      ],
    },
    {
      id: 'rejected',
      when: (r) => r.events.some((e) => e.type === 'push-rejected' && e.reason === 'non-fast-forward'),
      say: [
        {
          from: 'greg',
          text: 'rejected. that\'s git protecting you: you rewrote history, so your main no longer contains what github has. do NOT --force it. revert instead.',
        },
      ],
    },
    {
      id: 'revert-made',
      when: (r) => r.events.some((e) => e.type === 'revert' && e.stage === 'done'),
      say: [{ from: 'todd', text: 'the revert commit even says “This reverts commit ...” in the message!! my mistake will be documented forever 🥲' }],
    },
  ],

  fails: [
    {
      id: 'force-main',
      check: (r) =>
        r.probe.forcePushed('main')
          ? {
              from: 'greg',
              title: 'Shared History Rewritten',
              body:
                'You force-pushed `main`. Commits that other people already had are gone from GitHub, 14 teammates now have local histories that no longer match the server, ' +
                'and the next person to `git pull` will get a confusing merge that may resurrect the bug. Greg is drafting a very long post-mortem.',
            }
          : null,
    },
  ],

  outro: [
    { from: 'priya', text: 'deployed the revert. $19.99 costs $19.99 again. finance has stopped emailing me. for now.' },
    { from: 'dana', text: 'Perfect! Clean undo, and history tells the whole story. 📜' },
    { from: 'todd', text: 'i will now be writing tests. apparently that\'s a thing?' },
  ],

  debrief: {
    title: 'Revert vs. reset',
    points: [
      '`git reset` moves a branch pointer backwards: commits after that point drop off the branch. Fine for local, unpushed work.',
      'On a shared branch, rewriting history breaks everyone who already pulled it. Their copies no longer match the server, and a force push can silently delete other people\'s commits.',
      '`git revert <commit>` instead records a *new* commit that applies the inverse change. History only moves forward, so it\'s safe on shared branches, and the undo is documented.',
      'Reverting a merge commit needs `git revert -m 1 <merge>` to say which parent is the “mainline” to go back to.',
    ],
  },

  solution: ['git log --oneline', 'git revert HEAD~2 --no-edit', 'git push'],
  par: 2,
};
