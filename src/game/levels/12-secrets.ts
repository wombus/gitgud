import { AUTHORS } from '../characters';
import type { Level } from '../types';

const BRANCH = 'feature/stripe-webhook';
const ENV = `STRIPE_SECRET_KEY=sk_live_51Hc0ngl0m0N0tAR3alK3yButStillD0ntPushTh1s
DATABASE_URL=postgres://billing:hunter2@prod-db.internal:5432/billing
`;
const WEBHOOK = `// Stripe calls this when a payment succeeds (or when it feels like it).
export async function handleWebhook(event) {
  if (event.type === 'payment_intent.succeeded') {
    return { ok: true, message: 'cha-ching' };
  }
  return { ok: true, message: 'ignored' };
}
`;

export const level12: Level = {
  id: 'secrets',
  ticket: 'CONG-1012',
  title: 'Loose Lips Sink Ships',
  clock: '2026-03-04 16:44',
  summary: 'Get a secrets file out of an unpushed commit, ignore it, and push clean.',
  concepts: ['git rm --cached', '.gitignore', 'git commit --amend', 'secrets hygiene'],
  repo: 'billing-service',
  hosted: 'conglomo/billing-service',

  async setup(b) {
    b.at('2026-02-11 10:00');
    const h = b.hub('conglomo', 'billing-service', { description: 'Sends invoices. Receives excuses.' });
    h.commit('main', { 'README.md': '# billing-service\n', '.gitignore': 'node_modules/\n*.log\n' }, 'Billing service', AUTHORS.greg);
    h.protect('main');
    b.clone(h);
    b.at('2026-03-04 15:10');
    await b.run('billing-service', `git switch -c ${BRANCH}`);
    b.write('billing-service', { 'webhook.js': 'export async function handleWebhook(event) {\n  // TODO\n}\n' });
    await b.run('billing-service', 'git add webhook.js', 'git commit -m "Scaffold webhook handler"', `git push -u origin ${BRANCH}`);
    b.at('2026-03-04 16:39');
    b.write('billing-service', { 'webhook.js': WEBHOOK, '.env': ENV });
    await b.run('billing-service', 'git add .', 'git commit -m "Handle Stripe payment webhooks"');
    b.cwd('billing-service');
  },

  intro: [
    { from: 'priya', text: 'STOP. don\'t push.' },
    { from: 'priya', text: `your last commit on \`${BRANCH}\` contains \`.env\`. with the LIVE stripe key in it. and the prod database password.` },
    { from: 'greg', text: 'bots scrape github for keys within minutes. if that goes up we\'re rotating keys all evening and i\'m cancelling my dentist appointment. i like my dentist.' },
    {
      from: 'dana',
      text: 'Please get `.env` out of that commit. Keep your local copy (you need it to run the app!), make sure git ignores it from now on, then push. 🙏',
    },
  ],

  objectives: [
    {
      id: 'out',
      text: 'Remove .env from every unpushed commit (keep the file on disk)',
      check: (p) =>
        p.file('.env') === ENV &&
        !p.filesAt(BRANCH).includes('.env') &&
        !p.range(`origin/${BRANCH}`, BRANCH).some((h) => p.repo!.commitFiles(h).has('.env')),
    },
    {
      id: 'ignore',
      text: 'Commit a .gitignore rule so .env is ignored from now on',
      check: (p) => /^\/?\.env\s*$/m.test(p.fileAt(BRANCH, '.gitignore') ?? '') && !!p.repo?.isIgnored('.env'),
    },
    { id: 'keep', text: 'Keep the webhook code committed', check: (p) => p.fileAt(BRANCH, 'webhook.js') === WEBHOOK },
    { id: 'push', text: 'Push the clean branch', check: (p) => p.pushed(BRANCH) && p.remoteFile(BRANCH, 'webhook.js') === WEBHOOK },
  ],

  hints: [
    '`git rm --cached .env` removes .env from the index (so the next commit won\'t contain it) but leaves the file on disk.',
    'Add an ignore rule: `echo ".env" >> .gitignore`, then `git add .gitignore`.',
    'Rewrite the last commit. It isn\'t pushed yet, so that\'s safe: `git commit --amend --no-edit`. Then `git push`.',
  ],

  reactions: [
    {
      id: 'deleted-env',
      when: (r) => !r.probe.repo?.worktree.has('.env') && r.events.some((e) => e.type === 'rm' || (e.type === 'git' && e.cmd === 'rm')),
      say: [{ from: 'dana', text: 'Careful, you still need your local `.env` to run the app! `git rm --cached` removes it from git but keeps the file. (`git checkout HEAD -- .env` brings it back.)' }],
    },
    {
      id: 'new-commit',
      when: (r) => r.probe.range(`origin/${BRANCH}`, BRANCH).length > 1 && r.probe.historyContains(BRANCH, '.env'),
      say: [
        {
          from: 'greg',
          text: 'you made a *new* commit that deletes .env. but the commit before it still contains the key. history remembers. amend the original instead (or squash them).',
        },
      ],
    },
    {
      id: 'ignored-but-tracked',
      when: (r) => !!r.probe.repo?.isIgnored('.env') && !!r.probe.repo?.index.has('.env'),
      say: [{ from: 'todd', text: 'ooh fun fact: .gitignore only ignores *untracked* files. if .env is already tracked, git keeps tracking it until you `git rm --cached` it!' }],
    },
  ],

  fails: [
    {
      id: 'leaked',
      check: (r) =>
        r.probe.remoteHistoryContains(BRANCH, '.env')
          ? {
              from: 'priya',
              title: 'Credentials Leaked',
              body:
                'A commit containing `.env` (live Stripe key, production database password) was pushed to GitHub. Automated scrapers found it in 4 minutes. ' +
                'Keys are being rotated, the database is being re-credentialed, and Greg has cancelled his dentist appointment. Removing the file later does not help: it is in the history.',
            }
          : null,
    },
  ],

  outro: [
    { from: 'priya', text: 'checked the branch on github. no .env anywhere in history. i can go home. i can actually go home.' },
    { from: 'greg', text: 'dentist appointment: saved.' },
  ],

  debrief: {
    title: 'Keeping secrets out of git',
    points: [
      'Once something is in a commit, it\'s in the history. Deleting the file in a *later* commit doesn\'t remove it from earlier ones. If it was pushed, assume it\'s compromised and rotate it.',
      'Before pushing, you can still fix it: `git rm --cached <file>` untracks the file (keeping it on disk) and `git commit --amend` rewrites the unpushed commit without it.',
      '`.gitignore` only affects *untracked* files. Already-tracked files stay tracked, which is why `rm --cached` came first.',
      'Deeper in history or already pushed? That\'s a job for `git filter-repo` plus credential rotation.',
    ],
  },

  solution: ['git rm --cached .env', 'echo ".env" >> .gitignore', 'git add .gitignore', 'git commit --amend --no-edit', 'git push'],
  par: 5,
};
