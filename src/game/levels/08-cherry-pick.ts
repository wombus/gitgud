import { AUTHORS } from '../characters';
import type { Level } from '../types';

const SEARCH_BASE = `import { query } from './db.js';

export function search(term) {
  return query(\`SELECT * FROM products WHERE name LIKE '%\${term}%'\`);
}
`;
const SEARCH_FIXED = `import { query } from './db.js';
import { sanitize } from './sanitize.js';

export function search(term) {
  return query(\`SELECT * FROM products WHERE name LIKE '%\${sanitize(term)}%'\`);
}
`;
const SANITIZE = `// Escape anything a user types before it goes near SQL.
// (Yes, parameterized queries are better. There's a ticket. There's always a ticket.)
export function sanitize(input) {
  return String(input).replace(/['";\\\\%_-]/g, '');
}
`;

const REL = 'release/2.4';

export const level08: Level = {
  id: 'cherry-pick',
  ticket: 'CONG-1008',
  title: 'Patch Tuesday',
  clock: '2026-03-03 16:28',
  summary: 'Backport one fix to a release branch with cherry-pick, then tag the release.',
  concepts: ['git cherry-pick', 'release branches', 'git tag -a', 'git push <tag>'],
  repo: 'search-api',
  hosted: 'conglomo/search-api',

  setup(b) {
    b.at('2026-02-09 11:00');
    const h = b.hub('conglomo', 'search-api', { description: 'Finds products. Sometimes the right ones.' });
    h.commit('main', { 'search.js': SEARCH_BASE, 'db.js': 'export const query = (sql) => sql;\n', 'VERSION': '2.4.0\n' }, 'Search API 2.4', AUTHORS.greg);
    h.branch(REL, 'main');
    h.tag('v2.4.0', REL);
    h.commit('main', { 'VERSION': '2.5.0-dev\n' }, 'Start 2.5 development', AUTHORS.dana);
    h.commit('main', { 'fuzzy.js': 'export const fuzzy = () => "beta, do not ship";\n' }, 'Add fuzzy search (beta)', AUTHORS.greg);
    b.world.data.fix = h.commit('main', { 'search.js': SEARCH_FIXED, 'sanitize.js': SANITIZE }, 'Sanitize user input in search', AUTHORS.priya);
    h.commit('main', { 'analytics.js': 'export const track = () => "also not ready";\n' }, 'Add search analytics dashboard (WIP)', AUTHORS.todd);
    b.clone(h);
    b.cwd('search-api');
  },

  intro: [
    { from: 'priya', text: 'the security scanner found SQL injection in search. on 2.4. which is what every customer is running.' },
    { from: 'priya', text: '`main` already has the fix: “Sanitize user input in search”.' },
    {
      from: 'dana',
      text: `We need a 2.4.1 patch with ONLY that fix. \`main\` also has half-finished 2.5 features that absolutely cannot ship yet. Put the fix on \`${REL}\`, push it, then tag it \`v2.4.1\`.`,
    },
    { from: 'greg', text: 'do not merge main into the release branch. pick the one commit. and push the tag. the deploy pipeline watches tags, not branches.' },
  ],

  objectives: [
    {
      id: 'pick',
      text: `Get ONLY the security fix onto ${REL}`,
      check: (p) =>
        p.fileAt(REL, 'search.js') === SEARCH_FIXED &&
        p.fileAt(REL, 'sanitize.js') === SANITIZE &&
        !p.filesAt(REL).some((f) => f === 'fuzzy.js' || f === 'analytics.js') &&
        p.fileAt(REL, 'VERSION') === '2.4.0\n',
    },
    {
      id: 'push',
      text: `Push ${REL}`,
      check: (p) => p.remoteFile(REL, 'search.js') === SEARCH_FIXED && p.pushed(REL),
    },
    {
      id: 'tag',
      text: 'Tag the release v2.4.1 and push the tag',
      check: (p) => {
        const host = p.host;
        const tag = host?.refs.get('refs/tags/v2.4.1');
        return !!host && !!tag && host.objects.peel(tag) === host.branchHash(REL);
      },
    },
  ],

  hints: [
    `Get the release branch locally: \`git switch ${REL}\` (git creates a local branch tracking origin/${REL}).`,
    'Find the fix\'s hash: `git log --oneline main`.',
    '`git cherry-pick <hash>` copies that commit\'s change onto your current branch as a new commit. Then `git push`.',
    'Tag the new tip: `git tag -a v2.4.1 -m "Patch release 2.4.1"`, then `git push origin v2.4.1`. Tags aren\'t pushed by default.',
  ],

  reactions: [
    {
      id: 'merged-main',
      when: (r) => r.probe.branch() === REL && r.probe.filesAt(REL).includes('fuzzy.js'),
      say: [
        {
          from: 'greg',
          text: 'you just merged half of 2.5 into the release branch. it\'s local, so no harm yet. `git reset --hard origin/release/2.4` and cherry-pick instead.',
        },
      ],
    },
    {
      id: 'tag-not-pushed',
      when: (r) => /^git tag\b/.test(r.command) && r.code === 0 && !!r.probe.repo?.getRef('refs/tags/v2.4.1') && !r.probe.host?.refs.get('refs/tags/v2.4.1'),
      say: [{ from: 'priya', text: 'nice tag. the pipeline can\'t see it though, tags stay local until you push them: `git push origin v2.4.1`' }],
    },
    {
      id: 'lightweight',
      when: (r) => /^git tag v2\.4\.1\b/.test(r.command) && r.code === 0,
      say: [{ from: 'greg', text: 'lightweight tag. works. `-a -m` makes an annotated one with an author and message. release tags should be annotated. i\'m just saying.' }],
    },
  ],

  fails: [
    {
      id: 'shipped-beta',
      check: (r) =>
        r.probe.remoteHistoryContains(REL, 'fuzzy.js') || r.probe.remoteHistoryContains(REL, 'analytics.js')
          ? {
              from: 'dana',
              title: 'Unreleased Features Shipped',
              body:
                'The 2.4 release branch on GitHub now contains unfinished 2.5 work (fuzzy search, a WIP analytics dashboard). ' +
                'The pipeline built it, customers got it, and Marketing is now announcing features that don\'t work. The launch party is next week. For the wrong version.',
            }
          : null,
    },
  ],

  outro: [
    { from: 'system', text: '🔔 Deploy pipeline: v2.4.1 released to production ✅' },
    { from: 'priya', text: 'patched. no more SQL injection. the scanner is quiet. i\'m going to enjoy this silence.' },
    { from: 'dana', text: 'A surgical backport! 🩺 Great way to end the day.' },
  ],

  debrief: {
    title: 'Cherry-pick & tags',
    points: [
      '`git cherry-pick <commit>` re-applies the change a commit introduced on top of your current branch, as a brand-new commit (new hash, same author).',
      'It\'s ideal for backporting a fix to a release branch. Merging would have dragged along every other commit on main.',
      'Add `-x` to record “(cherry picked from commit …)” in the message so people can trace the backport.',
      'A tag is a permanent name for one commit, typically a release. Annotated tags (`-a`) store a message, author and date. Tags aren\'t pushed by default: `git push origin <tag>` or `--tags`.',
    ],
  },

  solution: [`git switch ${REL}`, 'git log --oneline main', 'git cherry-pick main~1', 'git push', 'git tag -a v2.4.1 -m "Patch release 2.4.1"', 'git push origin v2.4.1'],
  par: 5,
};
