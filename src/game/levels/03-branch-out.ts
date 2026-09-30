import { AUTHORS } from '../characters';
import type { Level } from '../types';
import { INDEX_FIXED, INDEX_TYPO, STYLES } from './02-the-typo';

export const NEWSLETTER = `<!DOCTYPE html>
<html>
<body>
  <h2>Subscribe to the Conglomo Synergy Digest™</h2>
  <p>Weekly insights. Monthly paradigms. Quarterly layoffs (just kidding!!)</p>
  <form action="/subscribe" method="post">
    <input type="email" name="email" placeholder="you@company.com">
    <button>Synergize me</button>
  </form>
</body>
</html>
`;

export const BRANCH = 'feature/newsletter-signup';

export function websiteBase(b: Parameters<Level['setup']>[0]) {
  b.at('2026-01-12 14:00');
  const h = b.hub('conglomo', 'website', { description: 'conglomo.com — the face of synergy' });
  h.commit('main', { 'index.html': INDEX_TYPO.replace('Welcom to Conglomo', 'Coming soon'), 'styles.css': STYLES }, 'Initial website', AUTHORS.greg);
  h.commit('main', { 'index.html': INDEX_TYPO }, 'Add homepage copy from Marketing', AUTHORS.dana, { minutes: 60 * 26 });
  h.commit('main', { 'index.html': INDEX_FIXED }, 'Fix typo in homepage heading', AUTHORS.todd, { minutes: 60 * 24 * 40 });
  h.protect('main');
  return h;
}

export const level03: Level = {
  id: 'branch-out',
  ticket: 'CONG-1003',
  title: 'Branch Out',
  clock: '2026-03-02 11:15',
  summary: 'Create a feature branch, commit on it, and push it with an upstream.',
  concepts: ['git switch -c', 'branches', 'git push -u', 'upstream'],
  repo: 'website',
  hosted: 'conglomo/website',

  setup(b) {
    const h = websiteBase(b);
    b.clone(h);
    b.write('website', { 'newsletter.html': NEWSLETTER });
    b.cwd('website');
  },

  intro: [
    { from: 'dana', text: 'Quick process note! We *never* commit directly to `main`. Every change goes on its own branch, then through a pull request. 🌳' },
    { from: 'greg', text: 'because of todd.', delay: 600 },
    { from: 'todd', text: 'ONE TIME', delay: 300 },
    {
      from: 'dana',
      text: `Design finished the newsletter signup page: \`newsletter.html\` is sitting in your website folder. Please put it on a branch called \`${BRANCH}\`, commit it, and push that branch to GitHub.`,
    },
    { from: 'greg', text: '`git switch -c <name>` makes a branch and moves you onto it. the first push of a new branch needs `-u`. you\'ll see why.' },
  ],

  objectives: [
    { id: 'branch', text: `Create a branch named ${BRANCH}`, check: (p) => !!p.repo?.branchHash(BRANCH) },
    { id: 'commit', text: 'Commit newsletter.html on that branch', check: (p) => p.fileAt(BRANCH, 'newsletter.html') === NEWSLETTER },
    {
      id: 'main-clean',
      text: 'Leave main untouched (no new commits on it)',
      check: (p) => p.fileAt(BRANCH, 'newsletter.html') !== undefined && p.rev('main') === p.rev('origin/main'),
    },
    {
      id: 'push',
      text: 'Push the branch and set its upstream',
      check: (p) => p.pushed(BRANCH) && p.upstreamOf(BRANCH) === `origin/${BRANCH}`,
    },
  ],

  hints: [
    `Create the branch and switch to it in one step: \`git switch -c ${BRANCH}\` (the older equivalent is \`git checkout -b\`).`,
    'Then stage and commit: `git add newsletter.html` and `git commit -m "Add newsletter signup page"`.',
    `A brand-new branch has no upstream. \`git push -u origin ${BRANCH}\` pushes it *and* records origin/${BRANCH} as its upstream, so a plain \`git push\` works next time.`,
    `Committed on main by mistake? Create the branch right where you are (\`git branch ${BRANCH}\`), then put main back: \`git switch main\` and \`git reset --hard origin/main\`. Your commit lives on in the new branch.`,
  ],

  reactions: [
    {
      id: 'protected',
      when: (r) => r.events.some((e) => e.type === 'push-rejected' && e.reason === 'protected'),
      say: [{ from: 'greg', text: '“protected branch hook declined”. translation: you tried to push to main. see above re: todd.' }],
    },
    {
      id: 'no-upstream',
      when: (r) => r.output.includes('has no upstream branch'),
      say: [{ from: 'greg', text: 'read the error. git literally printed the exact command you need. it\'s right there. copy it.' }],
    },
    {
      id: 'committed-on-main',
      when: (r) => r.probe.branch() === 'main' && r.probe.range('origin/main', 'main').length > 0,
      say: [{ from: 'dana', text: 'Hmm, that commit landed on `main` locally. No worries, it isn\'t lost! You can move it to a branch. (`hint` can help.) 🙂' }],
    },
    {
      id: 'branch-made',
      when: (r) => r.probe.branch() === BRANCH,
      say: [{ from: 'todd', text: 'look at your prompt!! it says the branch name now 😍 that\'s how you know where your commits will go' }],
    },
  ],

  outro: [
    { from: 'system', text: `🔔 junior-dev pushed a new branch: ${BRANCH}` },
    { from: 'greg', text: 'branch. commit. upstream. you are now more qualified than the intern.' },
    { from: 'todd', text: 'hey!!!', delay: 400 },
    { from: 'dana', text: 'Perfect! After lunch we\'ll turn that branch into a pull request. 🥪' },
  ],

  debrief: {
    title: 'Branches are just pointers',
    points: [
      'A branch is a lightweight, movable label pointing at a commit. Creating one costs nothing, which is why teams make one per change.',
      '`git switch -c name` creates a branch at your current commit and moves HEAD onto it. New commits advance *that* branch and leave `main` alone.',
      '`git push -u origin <branch>` uploads your commits and sets the *upstream* (tracking) branch. From then on `git status` can tell you ahead/behind, and `git push` / `git pull` need no arguments.',
      'Protected branches are a GitHub rule, not a git feature: the server rejects direct pushes so every change goes through review.',
    ],
  },

  solution: [`git switch -c ${BRANCH}`, 'git add newsletter.html', 'git commit -m "Add newsletter signup page"', `git push -u origin ${BRANCH}`],
  par: 4,
};
