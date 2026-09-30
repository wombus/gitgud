import { AUTHORS } from '../characters';
import type { Level } from '../types';

const REL = 'release/4.0';

const CART_BROKEN = `export function checkoutTotal(cart) {
  return cart.items.reduce((sum, item) => sum + item.price * item.qty);
}
`;
const CART_FIXED = `export function checkoutTotal(cart) {
  if (!cart?.items?.length) return 0;
  return cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
`;

export const level14: Level = {
  id: 'friday-release',
  ticket: 'CONG-1014',
  title: 'Friday, 4:47 PM',
  clock: '2026-03-06 16:47',
  summary: 'Untangle Todd\'s half-finished rebase, rescue his detached-HEAD fix, and ship the release.',
  concepts: ['git status', 'git rebase --abort', 'detached HEAD', 'git reflog', 'cherry-pick', 'release tags'],
  repo: 'conglomo-app',
  hosted: 'conglomo/conglomo-app',
  identity: AUTHORS.todd,
  machine: { user: 'todd', host: 'TODDS-MACBOOK' },

  async setup(b) {
    b.at('2026-02-16 10:00');
    const h = b.hub('conglomo', 'conglomo-app', { description: 'The monolith. Abandon hope.' });
    h.commit('main', { 'cart.js': CART_BROKEN, 'VERSION': '4.0.0-dev\n', 'app.js': 'export const APP = "Conglomo";\n' }, 'Conglomo App 4.0 development', AUTHORS.greg);
    h.branch(REL, 'main');
    h.commit(REL, { 'app.js': 'export const APP = "Conglomo"; // release candidate\n' }, 'Prepare 4.0 release candidate', AUTHORS.dana);
    h.tag('v4.0-rc2', REL);
    b.world.data.mainOnly = h.commit('main', { 'VERSION': '4.1.0-dev\n', 'hologram.js': 'export const HOLOGRAMS = "Marcus asked for this";\n' }, 'Start 4.1: holographic checkout (experimental)', AUTHORS.marcus);
    h.commit(REL, { 'VERSION': '4.0.0\n' }, 'Set version to 4.0.0', AUTHORS.dana);
    b.clone(h);
    // Todd's afternoon, reconstructed from his shell history:
    b.at('2026-03-06 11:20');
    await b.run('conglomo-app', `git switch ${REL}`, 'git checkout v4.0-rc2');
    b.write('conglomo-app', { 'cart.js': CART_FIXED });
    await b.run('conglomo-app', 'git commit -am "Fix checkout crash on empty cart"');
    b.world.data.fix = b.world.dirs.get('conglomo-app')!.headHash()!;
    await b.run('conglomo-app', `git switch ${REL}`);
    b.at('2026-03-06 11:58');
    // "let me just update the release with the latest main real quick"
    await b.shell.run('cd ~/conglomo-app');
    await b.shell.run('git rebase main');
    b.shell.history = [];
    b.world.data.relTip = h.host.branchHash(REL)!;
    b.cwd('conglomo-app');
  },

  intro: [
    { from: 'dana', text: 'Hi! Quick favor before the weekend. 🙂 Todd left for vacation at noon. The 4.0 release goes out at 5:00.' },
    { from: 'todd', text: 'hiii from the airport ✈️ IT gave you remote access to my laptop!! i was ~finishing~ the release. it\'s mostly done!!!' },
    { from: 'greg', text: 'i looked at his terminal. he\'s in the middle of rebasing `release/4.0` onto `main`. a *shared release branch*. onto *main*. with conflicts.' },
    { from: 'greg', text: 'also his crash fix isn\'t on any branch. he committed it on a detached HEAD and wandered off. it\'s in the reflog somewhere.' },
    {
      from: 'priya',
      text: 'requirements: release/4.0 must contain todd\'s crash fix. it must NOT contain 4.1 stuff from main. it must be tagged `v4.0.0`. the pipeline deploys when the tag lands.',
    },
    { from: 'dana', text: 'You\'ve got this! It\'s 4:47 on a Friday. What could possibly go wrong? 🙂' },
  ],

  objectives: [
    {
      id: 'abort',
      text: `Get out of Todd's rebase with ${REL} intact`,
      check: (p) => {
        const r = p.repo;
        const tip = p.rev(REL);
        return !!r && !r.op && p.branch() === REL && !!tip && !r.isAncestor(p.data.mainOnly, tip) && r.isAncestor(p.data.relTip, tip);
      },
    },
    { id: 'rescue', text: `Rescue Todd's crash fix onto ${REL}`, check: (p) => p.fileAt(REL, 'cart.js') === CART_FIXED },
    {
      id: 'push',
      text: `Push ${REL} (fast-forward, no 4.1 code)`,
      check: (p) => p.pushed(REL) && p.remoteFile(REL, 'cart.js') === CART_FIXED && !p.remoteHistoryContains(REL, 'hologram.js'),
    },
    {
      id: 'tag',
      text: 'Tag v4.0.0 and push the tag',
      check: (p) => {
        const host = p.host;
        const t = host?.refs.get('refs/tags/v4.0.0');
        return !!host && !!t && host.objects.peel(t) === host.branchHash(REL);
      },
    },
  ],

  hints: [
    '`git status` explains the mess. `git rebase --abort` returns release/4.0 to exactly how it was before Todd started.',
    '`git reflog` shows Todd\'s detached-HEAD work: look for “commit: Fix checkout crash on empty cart” and note its hash.',
    `On ${REL}: \`git cherry-pick <hash>\` brings the fix over as a new commit. Then \`git push\`.`,
    '`git tag -a v4.0.0 -m "Release 4.0.0"` and `git push origin v4.0.0`.',
  ],

  reactions: [
    {
      id: 'aborted',
      when: (r) => r.events.some((e) => e.type === 'rebase' && e.stage === 'abort'),
      say: [{ from: 'greg', text: 'rebase aborted. release branch is back to sanity. now find the fix. reflog.' }],
    },
    {
      id: 'continued',
      when: (r) => r.events.some((e) => e.type === 'rebase' && e.stage === 'done') && !!r.probe.repo?.isAncestor(r.probe.data.mainOnly, r.probe.rev(REL) ?? ''),
      say: [{ from: 'priya', text: 'you finished the rebase. release/4.0 now contains 4.1 holographic checkout code. locally. do NOT push that. `git reset --hard origin/release/4.0`.' }],
    },
    {
      id: 'found-fix',
      when: (r) => /^git reflog/.test(r.command) && r.output.includes('Fix checkout crash'),
      say: [{ from: 'todd', text: 'THERE it is!! i knew i committed it somewhere. i just didn\'t know where. or what a branch was, apparently.' }],
    },
    {
      id: 'rejected',
      when: (r) => r.events.some((e) => e.type === 'push-rejected'),
      say: [{ from: 'greg', text: 'rejected means your release/4.0 isn\'t a fast-forward of github\'s. something\'s been rewritten. don\'t force it. check `git log --oneline --graph --all`.' }],
    },
  ],

  fails: [
    {
      id: 'shipped-4.1',
      check: (r) =>
        r.probe.remoteHistoryContains(REL, 'hologram.js')
          ? {
              from: 'dana',
              title: 'Experimental Code Shipped in 4.0',
              body:
                'The 4.0 release branch on GitHub now contains 4.1\'s experimental “holographic checkout”. The pipeline deployed it. ' +
                'Customers are being asked to "please rotate your device into the fourth dimension" to pay. Marcus is delighted. Nobody else is.',
            }
          : null,
    },
    {
      id: 'forced-release',
      check: (r) =>
        r.probe.forcePushed(REL)
          ? {
              from: 'greg',
              title: 'Release Branch Rewritten',
              body: 'You force-pushed `release/4.0`, a shared branch the whole team (and the deploy pipeline) builds from. Release branches only move forward.',
            }
          : null,
    },
  ],

  outro: [
    { from: 'system', text: '🔔 Deploy pipeline: v4.0.0 released to production ✅ (4:59 PM)' },
    { from: 'dana', text: 'IT SHIPPED. 🎉 One week in and you\'ve rescued a release, a payments service, several keys, and Todd. Performance review is Monday! 🙂' },
    { from: 'todd', text: 'omg thank you!!!! i owe you a coffee. from the sentient machine.' },
    { from: 'greg', text: 'not bad. for a junior.' },
    { from: 'people', text: '🎉 Reminder: Mandatory Fun begins NOW in the Synergy Room. Attendance is tracked. Fun is also tracked.' },
  ],

  debrief: {
    title: 'Putting it all together',
    points: [
      '`git status` is your map. It tells you when a rebase, merge, cherry-pick or bisect is in progress, and how to continue or abort.',
      '`--abort` exists for merge, rebase, cherry-pick and revert, and always returns you to the state before the operation began.',
      'Commits made on a detached HEAD aren\'t on any branch. Once you switch away, only the reflog remembers them. `git branch <name> <hash>` or a cherry-pick saves them.',
      'Release branches are shared: fixes get cherry-picked *in*, releases get *tagged*, and nobody rebases or force-pushes them.',
    ],
  },

  solution: ['git status', 'git rebase --abort', 'git reflog', 'git cherry-pick {{fix}}', 'git push', 'git tag -a v4.0.0 -m "Release 4.0.0"', 'git push origin v4.0.0'],
  par: 5,
};
