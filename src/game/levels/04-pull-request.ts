import type { Level } from '../types';
import { BRANCH, NEWSLETTER, websiteBase } from './03-branch-out';

const LINK_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#7\b/i;

export const level04: Level = {
  id: 'pull-request',
  ticket: 'CONG-1004',
  title: 'Request for Pull',
  clock: '2026-03-02 13:32',
  summary: 'Open a pull request, link an issue, squash-merge, and tidy up locally.',
  concepts: ['gh pr create', 'issues', 'squash merge', 'git pull', 'git branch -D'],
  repo: 'website',
  hosted: 'conglomo/website',

  async setup(b) {
    const h = websiteBase(b);
    h.host.requireApproval = true;
    h.issue({ title: 'Add newsletter signup page', body: 'Marketing wants emails. All the emails.', author: 'dana-whitfield', labels: ['feature'] });
    h.issue({ title: 'Homepage says “synergy” 14 times', body: 'this is the way', author: 'marcus-vale', labels: ['wontfix'] });
    h.issue({ title: 'Comic Sans', body: 'why', author: 'greg-hollis', labels: ['design', 'please'] });
    // Renumber so the newsletter issue is #7, as if the tracker had some history.
    h.host.issues.forEach((i, idx) => (i.number = 7 + idx));
    h.host.nextNumber = 12;
    b.clone(h);
    b.write('website', { 'newsletter.html': NEWSLETTER });
    b.at('2026-03-02 11:20');
    await b.run('website', `git switch -c ${BRANCH}`, 'git add newsletter.html', 'git commit -m "Add newsletter signup page"', `git push -u origin ${BRANCH}`);
    b.cwd('website');
  },

  intro: [
    { from: 'dana', text: 'Welcome back from lunch! 🥪 Let\'s get your newsletter page into `main` the right way: a pull request.' },
    {
      from: 'dana',
      text: 'Use the GitHub CLI: `gh pr create`. Put “Closes #7” in the description so issue #7 closes automatically when it merges. (`gh issue list` shows open issues.)',
    },
    { from: 'greg', text: 'i\'ll review it. i review everything. i am the bottleneck. it\'s fine. everything is fine.' },
    { from: 'dana', text: 'Once Greg approves: squash-merge it, then clean up after yourself (delete the branch, update your local `main`). 🧹' },
  ],

  objectives: [
    { id: 'pr', text: `Open a pull request from ${BRANCH} into main`, check: (p) => !!p.host?.pulls.some((pr) => pr.head === BRANCH) },
    {
      id: 'link',
      text: 'Link issue #7 in the PR description (“Closes #7”)',
      check: (p) => !!p.host?.pulls.some((pr) => pr.head === BRANCH && LINK_RE.test(`${pr.title}\n${pr.body}`)),
    },
    { id: 'merge', text: 'Merge the approved PR (we squash-merge)', check: (p) => !!p.host?.pulls.some((pr) => pr.head === BRANCH && pr.state === 'merged') },
    { id: 'issue', text: 'Issue #7 is closed', check: (p) => p.host?.issue(7)?.state === 'closed' },
    {
      id: 'tidy',
      text: 'Local main is up to date and the feature branch is deleted',
      check: (p) =>
        !!p.repo &&
        p.remoteFile('main', 'newsletter.html') === NEWSLETTER &&
        p.rev('main') === p.remoteBranch('main') &&
        !p.repo.branchHash(BRANCH),
    },
  ],

  hints: [
    '`gh issue list` shows open issues; `gh issue view 7` shows the one you\'re closing.',
    '`gh pr create --title "Add newsletter signup page" --body "Closes #7"` opens a PR from your current branch into main.',
    'Forgot the link? `gh pr edit <number> --body "Closes #7"` fixes the description.',
    'Merge it with `gh pr merge --squash --delete-branch`: that also switches you to main, pulls, and deletes the local branch.',
    `Cleaning up by hand instead: \`git switch main\`, \`git pull\`, then \`git branch -D ${BRANCH}\`. (Capital -D: a squash merge creates a *new* commit, so git doesn't see your branch as merged.)`,
  ],

  reactions: [
    {
      id: 'pr-opened',
      when: (r) => r.events.some((e) => e.type === 'pr-create'),
      effect: (p) => {
        const pr = p.host?.pulls.find((x) => x.head === BRANCH);
        pr?.reviews.push({ author: 'greg-hollis', state: 'APPROVED', body: 'lgtm. the button is 3px off. i will live with it. barely.' });
      },
      say: [
        { from: 'system', text: '🔔 greg-hollis approved your pull request' },
        { from: 'greg', text: 'approved. the button is 3px off. i will carry this with me.', delay: 400 },
      ],
    },
    {
      id: 'no-link',
      when: (r) => r.events.some((e) => e.type === 'pr-create') && !r.probe.host?.pulls.some((pr) => pr.head === BRANCH && LINK_RE.test(`${pr.title}\n${pr.body}`)),
      say: [{ from: 'dana', text: 'Could you link it to issue #7? Put “Closes #7” in the description (`gh pr edit <number> --body "Closes #7"`) so GitHub closes it automatically. 🙏' }],
    },
    {
      id: 'self-approve',
      when: (r) => r.output.includes('Can not approve your own pull request'),
      say: [{ from: 'greg', text: 'trying to approve your own PR. the audacity. i respect it. no.' }],
    },
    {
      id: 'non-squash',
      when: (r) => r.events.some((e) => e.type === 'pr-merge' && e.method !== 'squash'),
      say: [{ from: 'greg', text: 'we squash here. but fine. it\'s in. history will judge us both.' }],
    },
    {
      id: 'lowercase-d',
      when: (r) => /git branch -d/.test(r.command) && r.output.includes('not fully merged'),
      say: [{ from: 'todd', text: 'ooh i got that too!! after a squash merge git doesn\'t recognize the branch as merged. capital `-D` forces it 💪' }],
    },
  ],

  outro: [
    { from: 'system', text: '🔔 Issue #7 “Add newsletter signup page” was closed by a pull request' },
    { from: 'dana', text: 'Your first PR is merged! 🎉 Marketing is thrilled. Marketing is always thrilled.' },
    { from: 'people', text: '🎉 Reminder: “Welcome Wednesday” cake is on Friday this week. Please do not ask why.' },
  ],

  debrief: {
    title: 'Pull requests',
    points: [
      'A pull request isn\'t a git feature. It\'s GitHub\'s workflow for proposing that one branch be merged into another, with review and discussion on the way.',
      'Keywords like “Closes #7” or “Fixes #7” in a PR description or commit message link it to an issue, which GitHub closes automatically when it lands on the default branch.',
      'Squash merging turns all of a PR\'s commits into one new commit on main: clean history, but your branch\'s commits are not ancestors of main. That\'s why deleting the branch afterwards needs `-D`.',
      'After merging on GitHub, your local `main` is stale until you `git pull`. The server never pushes changes to you; you fetch them.',
    ],
  },

  solution: ['gh pr create --title "Add newsletter signup page" --body "Closes #7"', 'gh pr merge --squash --delete-branch'],
  par: 2,
};


