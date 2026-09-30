import { hasConflictMarkers } from '../../engine/diff';
import { AUTHORS } from '../characters';
import type { Level } from '../types';

const BRANCH = 'feature/currency-format';

const CONFIG_BASE = `# Payments service config
service: payments
region: us-east-1
timeout_ms: 3000
currency: USD
log_level: info
`;

const CONFIG_GREG = CONFIG_BASE.replace('timeout_ms: 3000', 'timeout_ms: 5000');
const CONFIG_MINE = CONFIG_BASE.replace('currency: USD', 'currency: USD,EUR');
export const CONFIG_RESOLVED = CONFIG_BASE.replace('timeout_ms: 3000', 'timeout_ms: 5000').replace('currency: USD', 'currency: USD,EUR');

const CURRENCY_JS = `// Formats amounts for display. Now with Euros! (Marketing said "international".)
export function formatCurrency(amount, currency = 'USD') {
  const symbol = currency === 'EUR' ? '€' : '$';
  return symbol + amount.toFixed(2);
}
`;

function resolvedOk(content: string | undefined): boolean {
  return (
    !!content &&
    !hasConflictMarkers(content) &&
    /^timeout_ms:\s*5000\s*$/m.test(content) &&
    /^currency:\s*USD,\s*EUR\s*$/m.test(content) &&
    !/^timeout_ms:\s*3000/m.test(content) &&
    (content.match(/^currency:/gm) ?? []).length === 1
  );
}

export const level05: Level = {
  id: 'merge-conflict',
  ticket: 'CONG-1005',
  title: 'Conflict Resolution Training',
  clock: '2026-03-02 15:41',
  summary: 'Fetch, merge main into your branch, and resolve a conflict by hand.',
  concepts: ['git fetch', 'git merge', 'merge conflicts', 'conflict markers'],
  repo: 'payments-service',
  hosted: 'conglomo/payments-service',

  async setup(b) {
    b.at('2026-02-02 10:00');
    const h = b.hub('conglomo', 'payments-service', { description: 'Takes money. Mostly correctly.' });
    h.commit('main', { 'config.yml': CONFIG_BASE, 'README.md': '# payments-service\n\nIf this is down, find Priya.\n' }, 'Initial payments config', AUTHORS.greg);
    h.protect('main');
    b.clone(h);
    b.at('2026-03-02 14:05');
    b.write('payments-service', { 'config.yml': CONFIG_MINE, 'currency.js': CURRENCY_JS });
    await b.run('payments-service', `git switch -c ${BRANCH}`, 'git add .', 'git commit -m "Support EUR in currency formatting"', `git push -u origin ${BRANCH}`);
    // Meanwhile, Greg merges a timeout change to main (you haven't fetched it yet).
    b.at('2026-03-02 15:10');
    const greg = h.commit('main', { 'config.yml': CONFIG_GREG }, 'Raise payment timeout to 5s (the bank is slow)', AUTHORS.greg, { minutes: 1 });
    b.world.data.greg = greg;
    h.host.pulls.push({
      number: 12,
      title: 'Support EUR in currency formatting',
      body: 'Marketing said “international”.',
      head: BRANCH,
      base: 'main',
      author: 'junior-dev',
      state: 'open',
      draft: false,
      createdAt: b.world.clock.now(),
      reviews: [],
      comments: [{ author: 'github-actions', body: 'This branch has conflicts that must be resolved.' }],
    });
    h.host.nextNumber = 13;
    b.cwd('payments-service');
  },

  intro: [
    { from: 'system', text: '🔔 PR #12 “Support EUR in currency formatting”: This branch has conflicts that must be resolved.' },
    { from: 'dana', text: 'Uh oh, your currency PR conflicts with `main`. Greg merged a change to the same config file. 😬' },
    { from: 'greg', text: 'i raised the payment timeout to 5000. the bank\'s API is slow. like, dial-up slow.' },
    {
      from: 'dana',
      text: `Please bring the latest \`main\` into \`${BRANCH}\` and resolve the conflict. Keep BOTH changes: Greg's \`timeout_ms: 5000\` and your \`currency: USD,EUR\`. Then push so the PR is mergeable again.`,
    },
    { from: 'greg', text: 'hint: your local `main` has no idea my commit exists. neither does your `origin/main`. yet.' },
  ],

  objectives: [
    {
      id: 'fetch-merge',
      text: `Bring Greg's latest main commit into ${BRANCH}`,
      check: (p) => {
        const r = p.repo;
        const tip = p.rev(BRANCH);
        return !!r && !!tip && r.objects.has(p.data.greg) && r.isAncestor(p.data.greg, tip);
      },
    },
    {
      id: 'resolve',
      text: 'Resolve config.yml: timeout_ms 5000 AND currency USD,EUR, no markers',
      check: (p) => p.noConflicts() && resolvedOk(p.fileAt(BRANCH, 'config.yml')),
    },
    {
      id: 'push',
      text: 'Push the updated branch',
      check: (p) => p.pushed(BRANCH) && resolvedOk(p.remoteFile(BRANCH, 'config.yml')),
    },
  ],

  hints: [
    'Your local repo doesn\'t know about Greg\'s commit. `git fetch` downloads it into `origin/main` without touching your branches.',
    `While on ${BRANCH}: \`git merge origin/main\`. Expect a CONFLICT in config.yml.`,
    '`nano config.yml`: delete the three marker lines (<<<<<<<, =======, >>>>>>>) and keep exactly one timeout line (5000) and one currency line (USD,EUR). Save with Ctrl+O, Enter; exit with Ctrl+X.',
    'Mark it resolved: `git add config.yml`. Conclude the merge: `git commit --no-edit`. Then `git push`.',
  ],

  reactions: [
    {
      id: 'stale-merge',
      when: (r) => /^git merge main\b/.test(r.command) && r.output.includes('Already up to date'),
      say: [{ from: 'greg', text: '“already up to date” because your local `main` is stale. `git fetch`, then merge `origin/main`.' }],
    },
    {
      id: 'conflict',
      when: (r) => r.output.includes('CONFLICT'),
      say: [
        {
          from: 'todd',
          text: 'ooh conflict markers!! between `<<<<<<<` and `=======` is YOUR version, between `=======` and `>>>>>>>` is THEIRS. delete the markers, keep what\'s right (i learned this yesterday 😎)',
        },
      ],
    },
    {
      id: 'markers-committed',
      when: (r) => r.probe.hasMarkers('config.yml', 'HEAD'),
      say: [{ from: 'priya', text: 'i see `<<<<<<<` inside a committed config file. the YAML parser is going to have *feelings* about that. please fix before pushing.' }],
    },
    {
      id: 'markers-pushed',
      when: (r) => hasConflictMarkers(r.probe.remoteFile(BRANCH, 'config.yml') ?? ''),
      say: [{ from: 'priya', text: 'aaand the conflict markers are on github now. CI is on fire. fix the file, commit, push again.' }],
    },
    {
      id: 'rebase-path',
      when: (r) => r.events.some((e) => e.type === 'rebase' && e.stage === 'start'),
      say: [{ from: 'greg', text: 'rebasing instead of merging. fancy. that works too, but you\'ll need `git push --force-with-lease` afterwards.' }],
    },
    {
      id: 'aborted',
      when: (r) => r.events.some((e) => e.type === 'merge-abort'),
      say: [{ from: 'todd', text: '`git merge --abort` is so nice. it\'s like the merge never happened. undo button!! ↩️' }],
    },
  ],

  outro: [
    { from: 'system', text: '🔔 PR #12: All checks have passed. This branch has no conflicts with the base branch.' },
    { from: 'greg', text: 'both changes, no markers. merged it. you may now say you have resolved a conflict. on your résumé. and in life.' },
    { from: 'dana', text: 'Great work today! 🌇 Go home. Or don\'t. We\'re a family. 🙂' },
  ],

  debrief: {
    title: 'Merge conflicts',
    points: [
      'Git merges line by line, using the common ancestor (the *merge base*) as the reference. If only one side changed a region, git takes that change automatically.',
      'When both sides changed the same (or adjacent) lines, git can\'t guess. It writes both versions between conflict markers and pauses the merge.',
      'Resolving means editing the file into its correct final state and removing every marker, then `git add` to mark it resolved and `git commit` to conclude.',
      '`git fetch` updates `origin/main` (your view of the remote); your local `main` only moves when you merge or pull. Merging a stale branch is how you get “Already up to date.”',
      '`git merge --abort` is the escape hatch: it puts everything back as it was.',
    ],
  },

  solution: ['git fetch', 'git merge origin/main', 'nano config.yml', 'git add config.yml', 'git commit --no-edit', 'git push'],
  solutionEdits: { 'config.yml': () => CONFIG_RESOLVED },
  par: 6,
};
