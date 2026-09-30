import { AUTHORS } from '../characters';
import type { Level } from '../types';

const README = `# Welcome to Conglomo Corp!

Congratulations on joining the fastest-growing* synergy platform in the tri-state area.
(*growth measured in number of Jira projects)

## Your first week
1. Set up git (you did that! probably)
2. Read this README (you're doing it!)
3. Never push directly to \`main\`
4. Never force push. Ever. Especially on Fridays.
5. If prod breaks, find Priya. If Priya is asleep, do not wake Priya.

## Useful commands
- \`git status\`         when in doubt, run this
- \`git log --oneline\`  see what happened
- \`git help <command>\` plain-English help

## FAQ
Q: Who is Gary?
A: We don't talk about Gary.
`;

export const level01: Level = {
  id: 'first-day',
  ticket: 'CONG-1001',
  title: 'Hello, World (Again)',
  clock: '2026-03-02 09:02',
  summary: 'Tell git who you are, then clone your first repository.',
  concepts: ['git config', 'git clone', 'cd'],
  repo: 'onboarding',
  hosted: 'conglomo/onboarding',
  identity: null,

  setup(b) {
    b.at('2019-06-11 10:00');
    const h = b.hub('conglomo', 'onboarding', { description: 'Start here! (Last updated: 2019)' });
    h.commit('main', { 'README.md': '# Onboarding\n\nTODO\n' }, 'Initial commit', AUTHORS.gary);
    h.commit(
      'main',
      {
        'README.md': README,
        'handbook/it-policy.md': '# IT Policy\n\n- Editors: nano. (See: The Incident of 2019.)\n- sudo: no.\n- Internet: mostly no.\n',
        'handbook/culture.md': '# Culture\n\nWe are a family.* \n\n*Not legally binding.\n',
      },
      'Write onboarding docs',
      AUTHORS.dana,
      { minutes: 60 * 24 * 3 },
    );
    b.cwd(null);
  },

  intro: [
    { from: 'dana', text: "Welcome to Conglomo Corp! 🎉 I'm Dana, your manager. So glad to have you on the team!" },
    {
      from: 'dana',
      text: 'Bad news: your laptop is still “in procurement.” Good news: you get Gary\'s old machine! Gary no longer works here. Please don\'t ask about Gary.',
    },
    {
      from: 'dana',
      text: 'First, git needs to know who you are. It signs your name on every commit you make. Forever. No pressure! 🙂\n`git config --global user.name "Your Name"`\n`git config --global user.email "you@conglomo.com"`',
    },
    {
      from: 'greg',
      text: 'use your actual name. the last guy used “xXx_d3str0yer_xXx”. it\'s in the blame for half the payments service. we see it every day.',
      delay: 1500,
    },
    {
      from: 'dana',
      text: 'Then clone our onboarding repo with `git clone git@github.com:conglomo/onboarding.git`, `cd` into it and read the README (`cat README.md`). Everything you need to know is in there. It was last updated in 2019.',
    },
    { from: 'it', text: '🤖 Tip: type `task` in your terminal to see your ticket, `hint` if you get stuck, and `help` for commands.', delay: 1200 },
  ],

  objectives: [
    {
      id: 'name',
      text: 'Set your name in git config (globally)',
      check: (p) => {
        const n = p.world.globalConfig.get('user.name')?.trim();
        return !!n && n.toLowerCase() !== 'your name';
      },
    },
    {
      id: 'email',
      text: 'Set your email in git config (globally)',
      check: (p) => /.+@.+/.test(p.world.globalConfig.get('user.email') ?? '') && p.world.globalConfig.get('user.email') !== 'you@conglomo.com',
    },
    {
      id: 'clone',
      text: 'Clone git@github.com:conglomo/onboarding.git',
      check: (p) => !!p.repo?.remoteUrl('origin'),
    },
    {
      id: 'readme',
      text: 'cd into the repo and read README.md',
      check: (p) => p.happened('command', (e) => e.dir === 'onboarding' && /^(cat|less|more|head)\b.*README/i.test(String(e.line))),
    },
  ],

  hints: [
    'Setting config is one command per value:\ngit config --global user.name "Pat Example"\ngit config --global user.email "pat@conglomo.com"\n(Use your own name. Not literally “Your Name”.)',
    'Clone copies the whole repository to a new folder named after it:\ngit clone git@github.com:conglomo/onboarding.git',
    'Move into the new folder with `cd onboarding`, then read the file with `cat README.md`.',
  ],

  reactions: [
    {
      id: 'placeholder-name',
      when: (r) => (r.probe.world.globalConfig.get('user.name') ?? '').toLowerCase() === 'your name',
      say: [{ from: 'greg', text: '“Your Name”. bold. i\'m sure that\'ll look great in the blame. (it\'s a placeholder. put your actual name.)' }],
    },
    {
      id: 'placeholder-email',
      when: (r) => r.probe.world.globalConfig.get('user.email') === 'you@conglomo.com',
      say: [{ from: 'dana', text: 'Ha! “you@conglomo.com” is a placeholder, silly. 🙂 Use your own email.' }],
    },
    {
      id: 'no-global',
      when: (r) => /^git config user\./.test(r.command) && r.code !== 0,
      say: [{ from: 'todd', text: 'you need `--global` when you\'re not inside a repo yet!! (i know because i also did that 5 min ago)' }],
    },
    {
      id: 'cloned',
      when: (r) => r.events.some((e) => e.type === 'clone'),
      say: [{ from: 'todd', text: 'omg you cloned it!! now `cd onboarding` to go inside. that\'s where the magic is ✨' }],
    },
  ],

  outro: [
    { from: 'greg', text: 'you now officially exist in git. that\'s more than most of the product roadmap can say.' },
    { from: 'dana', text: 'Amazing first ticket! 🙌 Next one is already in your queue. (It\'s always already in your queue.)' },
  ],

  debrief: {
    title: 'Identity & cloning',
    points: [
      '`git config --global` writes to your user-level config (~/.gitconfig). Every commit records the name and email set there. That\'s how `git log` and `git blame` know who did what.',
      'Leave off `--global` inside a repo to override it for that repo only (handy for a personal email on side projects).',
      '`git clone <url>` downloads the *entire* history, not just the latest files. It sets up a remote named `origin` pointing at the URL and checks out the default branch.',
      'Git commands act on the repository you are *inside*. Outside one, you get “not a git repository”, which is why `cd` matters.',
    ],
  },

  solution: [
    'git config --global user.name "Pat Example"',
    'git config --global user.email "pat@conglomo.com"',
    'git clone git@github.com:conglomo/onboarding.git',
    'cd onboarding',
    'cat README.md',
  ],
  par: 3,
};
