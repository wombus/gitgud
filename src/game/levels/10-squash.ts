import { AUTHORS } from '../characters';
import type { Level } from '../types';

const BRANCH = 'feature/search-filters';
const BAD = /\b(wip|pls|please work|fix again|asdf)\b|^fix$|^fixed$/i;

const FILTERS_FINAL = `export function applyFilters(products, { minPrice = 0, maxPrice = Infinity, inStock = false } = {}) {
  return products.filter(
    (p) => p.price >= minPrice && p.price <= maxPrice && (!inStock || p.stock > 0),
  );
}
`;

export const level10: Level = {
  id: 'squash',
  ticket: 'CONG-1010',
  title: 'Make It Look Intentional',
  clock: '2026-03-04 11:40',
  summary: 'Squash a messy branch into one clean commit and update the remote.',
  concepts: ['git rebase -i', 'squash / fixup', 'git reset --soft', 'rewriting your own history'],
  repo: 'search-api',
  hosted: 'conglomo/search-api',

  async setup(b) {
    b.at('2026-02-09 11:00');
    const h = b.hub('conglomo', 'search-api', { description: 'Finds products. Sometimes the right ones.' });
    h.commit('main', { 'search.js': 'export const search = () => [];\n', 'README.md': '# search-api\n' }, 'Search API', AUTHORS.greg);
    h.protect('main');
    b.clone(h);
    b.at('2026-03-03 13:00');
    await b.run('search-api', `git switch -c ${BRANCH}`);
    const steps: Array<[string, string]> = [
      ['export function applyFilters(products) {\n  return products;\n}\n', 'Add search filters'],
      ['export function applyFilters(products, { minPrice = 0 } = {}) {\n  return products.filter((p) => p.price > minPrice);\n}\n', 'wip'],
      ['export function applyFilters(products, { minPrice = 0, maxPrice = Infinity } = {}) {\n  return products.filter((p) => p.price >= minPrice && p.price <= maxPrice);\n}\n', 'fix'],
      [FILTERS_FINAL.replace('p.stock > 0', 'p.stock'), 'fix again'],
      [FILTERS_FINAL, 'pls work'],
    ];
    for (const [content, msg] of steps) {
      b.write('search-api', { 'filters.js': content });
      await b.run('search-api', 'git add filters.js', `git commit -m "${msg}"`);
    }
    await b.run('search-api', `git push -u origin ${BRANCH}`);
    b.world.data.tree = b.world.dirs.get('search-api')!.objects.commit(b.world.dirs.get('search-api')!.headHash()!).tree;
    b.cwd('search-api');
  },

  intro: [
    { from: 'greg', text: 'i\'m not reviewing a PR whose history reads “wip”, “fix”, “fix again”, “pls work”. it reads like a hostage situation.' },
    { from: 'greg', text: 'squash it into ONE commit with a real message. interactive rebase: `git rebase -i main`.' },
    { from: 'todd', text: 'or `git reset --soft main` and just commit again!! that\'s what i do 😎', delay: 900 },
    { from: 'greg', text: '...todd is right. both work. i hate it.', delay: 1200 },
    { from: 'dana', text: 'Then update the PR branch. You know the drill (lease, not force). 🙂' },
  ],

  objectives: [
    { id: 'one', text: `Squash ${BRANCH} into a single commit on top of main`, check: (p) => p.range('main', BRANCH).length === 1 && p.rev(`${BRANCH}~1`) === p.rev('main') },
    {
      id: 'message',
      text: 'Give it a real commit message',
      check: (p) => {
        if (p.range('main', BRANCH).length !== 1) return false;
        const s = p.subjects(BRANCH, 1)[0] ?? '';
        return s.trim().length >= 10 && !BAD.test(s.trim());
      },
    },
    {
      id: 'same-code',
      text: 'Keep the final code exactly the same',
      check: (p) => {
        const h = p.rev(BRANCH);
        return !!h && p.range('main', BRANCH).length === 1 && p.repo!.objects.commit(h).tree === p.data.tree;
      },
    },
    { id: 'push', text: 'Update the remote branch', check: (p) => p.pushed(BRANCH) && p.remoteFile(BRANCH, 'filters.js') === FILTERS_FINAL },
  ],

  hints: [
    '`git log --oneline main..HEAD` shows only the commits on your branch (five of them).',
    '`git rebase -i main` opens the todo list in nano. Keep the first line as `pick`, change the other four to `fixup` (or just `f`). Save with Ctrl+O, Enter; exit with Ctrl+X.',
    'Alternative: `git reset --soft main` “un-commits” everything but keeps it all staged. Then `git commit -m "Add price and stock filters to search"`.',
    'Push the rewritten branch: `git push --force-with-lease`.',
  ],

  reactions: [
    {
      id: 'squashed',
      when: (r) => r.probe.range('main', BRANCH).length === 1,
      say: [{ from: 'greg', text: 'one commit. i can review that. i won\'t enjoy it, but i can.' }],
    },
    {
      id: 'hard',
      when: (r) => r.events.some((e) => e.type === 'reset' && e.mode === 'hard'),
      say: [{ from: 'todd', text: 'uh oh, `--hard` throws the changes away!! `--soft` keeps them staged. (git reflog can get it back tho 🙏)' }],
    },
  ],

  outro: [
    { from: 'system', text: '🔔 greg-hollis approved PR #19 “Add price and stock filters to search”' },
    { from: 'greg', text: 'approved. nobody ever needs to know about “pls work”. except the reflog. the reflog knows.' },
  ],

  debrief: {
    title: 'Rewriting your own history',
    points: [
      'Interactive rebase (`git rebase -i`) lets you edit a series of commits: reorder, reword, squash, fixup, or drop them.',
      '`squash` melds a commit into the one above it and lets you combine the messages; `fixup` does the same but discards the fixup\'s message.',
      '`git reset --soft <base>` is the blunt instrument: it moves the branch back but leaves every change staged, ready to become one new commit.',
      'Tidy history makes `git log`, `git blame` and `git bisect` far more useful. Tidy *before* others build on your branch, and push with `--force-with-lease`.',
    ],
  },

  solution: ['git log --oneline main..HEAD', 'git reset --soft main', 'git commit -m "Add price and stock filters to search"', 'git push --force-with-lease'],
  par: 3,
};
