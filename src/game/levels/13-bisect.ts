import { shortHash } from '../../engine/objects';
import { AUTHORS } from '../characters';
import type { Level } from '../types';

const DISCOUNT_GOOD = `// Applies a percentage discount. pct is 0..1 (0.2 = 20% off).
export function applyDiscount(price, pct) {
  return Math.round(price * (1 - pct) * 100) / 100;
}
`;
const DISCOUNT_BAD = DISCOUNT_GOOD.replace('price * (1 - pct)', 'price * (1 - pct / 10)').replace(
  '// Applies a percentage discount.',
  '// Applies a percentage discount. Optimized!!',
);

type Change = [string, Record<string, string>, keyof typeof AUTHORS];

/** 24 commits after v3.0; the 15th breaks the discount math. */
function history(): Change[] {
  const noise: Array<[string, string, string, keyof typeof AUTHORS]> = [
    ['Bump lodash', 'package.json', '{ "name": "pricing-engine", "version": "3.0.1" }\n', 'greg'],
    ['Add tax table for Ohio', 'tax/oh.js', 'export const OH = 0.0575;\n', 'priya'],
    ['Document rounding rules', 'docs/rounding.md', 'We round half up. Finance insists.\n', 'dana'],
    ['Add tax table for Texas', 'tax/tx.js', 'export const TX = 0.0625;\n', 'priya'],
    ['Rename helper', 'util.js', 'export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));\n', 'greg'],
    ['Add currency constants', 'currency.js', 'export const CURRENCIES = ["USD", "EUR"];\n', 'greg'],
    ['Fix typo in README', 'README.md', '# pricing-engine\n\nCalculates prices. Please do not “optimize” it.\n', 'dana'],
    ['Add bulk pricing tiers', 'bulk.js', 'export const TIERS = [10, 50, 100];\n', 'marcus'],
    ['Add tax table for Oregon', 'tax/or.js', 'export const OR = 0;\n', 'priya'],
    ['Cache price lookups', 'cache.js', 'export const cache = new Map();\n', 'greg'],
    ['Update dependencies', 'package.json', '{ "name": "pricing-engine", "version": "3.1.0" }\n', 'greg'],
    ['Add holiday sale flag', 'flags.js', 'export const HOLIDAY_SALE = false;\n', 'dana'],
    ['Lint fixes', 'util.js', 'export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n', 'todd'],
    ['Add coupon codes', 'coupons.js', 'export const COUPONS = { SYNERGY10: 0.1 };\n', 'todd'],
  ];
  const out: Change[] = noise.map(([msg, f, c, who]) => [msg, { [f]: c }, who]);
  out.splice(14, 0, ['Optimize discount calculation', { 'discount.js': DISCOUNT_BAD }, 'todd']);
  const more: Array<[string, string, string, keyof typeof AUTHORS]> = [
    ['Add tax table for Nevada', 'tax/nv.js', 'export const NV = 0.0685;\n', 'priya'],
    ['Improve cache eviction', 'cache.js', 'export const cache = new Map(); // now with eviction (soon)\n', 'greg'],
    ['Add metrics', 'metrics.js', 'export const count = () => 1;\n', 'priya'],
    ['Tweak coupon copy', 'coupons.js', 'export const COUPONS = { SYNERGY10: 0.1, WELCOME5: 0.05 };\n', 'dana'],
    ['Add price history', 'history.js', 'export const history = [];\n', 'greg'],
    ['Refactor bulk tiers', 'bulk.js', 'export const TIERS = [10, 50, 100, 500];\n', 'marcus'],
    ['Add tax table for Utah', 'tax/ut.js', 'export const UT = 0.061;\n', 'priya'],
    ['Update README', 'README.md', '# pricing-engine\n\nCalculates prices. Please do not “optimize” it. (Seriously.)\n', 'greg'],
    ['Release notes for 3.2', 'CHANGELOG.md', '## 3.2.0\n- Many improvements\n', 'dana'],
  ];
  out.push(...more.map(([msg, f, c, who]): Change => [msg, { [f]: c }, who]));
  return out;
}

const TEST_PASS = `
> pricing-engine@3.2.0 test
> jest

 PASS  tests/tax.test.js
 PASS  tests/coupons.test.js
 PASS  tests/discount.test.js

Tests:       12 passed, 12 total
Time:        0.8 s`;

const TEST_FAIL = `
> pricing-engine@3.2.0 test
> jest

 PASS  tests/tax.test.js
 PASS  tests/coupons.test.js
 FAIL  tests/discount.test.js
  ● applyDiscount › takes 20% off

    expect(received).toBe(expected)

    Expected: 80
    Received: 98

Tests:       1 failed, 11 passed, 12 total
Time:        0.8 s`;

export const level13: Level = {
  id: 'bisect',
  ticket: 'CONG-1013',
  title: 'Who Broke the Build?',
  clock: '2026-03-05 10:03',
  summary: 'Binary-search 24 commits with git bisect to find where the tests broke.',
  concepts: ['git bisect', 'binary search', 'git bisect run', 'gh issue comment'],
  repo: 'pricing-engine',
  hosted: 'conglomo/pricing-engine',

  setup(b) {
    b.at('2026-02-02 09:00');
    const h = b.hub('conglomo', 'pricing-engine', { description: 'Calculates prices. Please do not “optimize” it.' });
    h.commit('main', { 'discount.js': DISCOUNT_GOOD, 'README.md': '# pricing-engine\n', 'package.json': '{ "name": "pricing-engine", "version": "3.0.0" }\n' }, 'pricing-engine 3.0', AUTHORS.greg);
    h.tag('v3.0', 'main');
    b.at('2026-02-10 09:00');
    for (const [msg, files, who] of history()) {
      const hash = h.commit('main', files, msg, AUTHORS[who], { minutes: 60 * 9 });
      if (msg === 'Optimize discount calculation') {
        b.world.data.bad = hash;
        b.world.data.bad7 = shortHash(hash);
      }
    }
    h.issue({ title: 'Tests failing on main: discount calculations', body: 'Green at v3.0, red now. 24 commits in between. Help.', author: 'priya-raman', labels: ['bug', 'ci'] });
    h.host.issues[0].number = 42;
    h.host.nextNumber = 43;
    b.clone(h);
    b.tests((repo) => {
      const d = repo.worktree.get('discount.js') ?? '';
      const pass = d.includes('price * (1 - pct)');
      return { pass, output: pass ? TEST_PASS : TEST_FAIL };
    });
    b.cwd('pricing-engine');
  },

  intro: [
    { from: 'priya', text: 'tests on main are red. issue #42. they were green at the `v3.0` tag. there are 24 commits since then.' },
    { from: 'greg', text: 'don\'t read 24 diffs. bisect. it\'s a binary search. 5 steps, tops.' },
    {
      from: 'greg',
      text: '`git bisect start`, mark the current commit bad, mark v3.0 good. then `npm test` at each step and tell git `good` or `bad`. or let `git bisect run npm test` do it for you. i\'m lazy, so i would.',
    },
    { from: 'dana', text: 'Please post the culprit\'s commit hash on issue #42 so we can follow up. Blamelessly, of course! 🙂 (…Todd.)' },
    { from: 'todd', text: 'why does everyone assume it\'s me', delay: 1500 },
  ],

  objectives: [
    {
      id: 'report',
      text: 'Post the first bad commit\'s hash on issue #42',
      check: (p) => !!p.host?.issue(42)?.comments.some((cm) => cm.body.toLowerCase().includes(p.data.bad7)),
    },
    {
      id: 'reset',
      text: 'End the bisect and get back to main',
      check: (p) => !!p.repo && !p.repo.bisect && p.branch() === 'main' && p.happened('bisect', (e) => e.stage === 'start'),
    },
  ],

  hints: [
    '`git bisect start`, then `git bisect bad` (the current commit is broken) and `git bisect good v3.0`.',
    'Git checks out the midpoint. Run `npm test`, then `git bisect good` or `git bisect bad`. Repeat. Or automate it: `git bisect run npm test`.',
    'When git prints “<hash> is the first bad commit”, post it: `gh issue comment 42 --body "Broken by <first 7+ chars of the hash>"`.',
    'Finish with `git bisect reset`. It returns you to the branch you started on.',
  ],

  reactions: [
    {
      id: 'found',
      when: (r) => r.events.some((e) => e.type === 'bisect' && e.stage === 'found'),
      say: [
        { from: 'todd', text: 'oh no. “Optimize discount calculation”. that\'s. that\'s me. i divided by 10 “for performance”.' },
        { from: 'greg', text: 'found in a handful of steps instead of 24. that\'s the power of binary search. and of todd being predictable.', delay: 1200 },
      ],
    },
    {
      id: 'wrong-hash',
      when: (r) => r.events.some((e) => e.type === 'issue-comment') && !r.probe.host?.issue(42)?.comments.some((cm) => cm.body.toLowerCase().includes(r.probe.data.bad7)),
      once: false,
      say: [{ from: 'priya', text: 'that\'s not the commit. i checked. bisect it and use the hash git prints as “the first bad commit”.' }],
    },
    {
      id: 'manual-step',
      when: (r) => r.events.some((e) => e.type === 'bisect' && e.stage === 'step') && !/run/.test(r.command),
      say: [{ from: 'greg', text: 'git checked out a midpoint. run `npm test`, then `git bisect good` or `git bisect bad` depending on the result.' }],
    },
  ],

  outro: [
    { from: 'system', text: '🔔 greg-hollis reverted “Optimize discount calculation”. CI is green.' },
    { from: 'dana', text: 'Great detective work! 🕵️ Todd, let\'s sync about “optimizations”. 🙂' },
    { from: 'todd', text: 'i\'m going to start adding tests before i optimize. apparently that\'s the order.' },
  ],

  debrief: {
    title: 'Bisect',
    points: [
      '`git bisect` is a binary search over history: every test halves the suspects, so 1,000 commits take about 10 steps.',
      'Give it one known-bad and one known-good commit; git checks out the midpoint and you mark it. Tags like `v3.0` make great “good” anchors.',
      '`git bisect run <cmd>` automates the whole thing: exit code 0 means good, anything else means bad.',
      'Bisect works best when every commit builds and passes on its own, which is another argument for small, focused commits.',
    ],
  },

  solution: ['git bisect start', 'git bisect bad', 'git bisect good v3.0', 'git bisect run npm test', 'gh issue comment 42 --body "First bad commit: {{bad7}}"', 'git bisect reset'],
  par: 5,
};
