import { AUTHORS } from '../characters';
import type { Level } from '../types';

export const INDEX_TYPO = `<!DOCTYPE html>
<html>
<head>
  <title>Conglomo Corp: Synergy, Delivered</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>Welcom to Conglomo</h1>
  <p>We leverage best-in-class paradigms to deliver synergy at scale.</p>
  <a href="/careers">We're hiring! (Please.)</a>
</body>
</html>
`;

export const INDEX_FIXED = INDEX_TYPO.replace('Welcom to', 'Welcome to');

export const STYLES = `body { font-family: "Comic Sans MS", sans-serif; } /* approved by Marcus */
h1 { color: #7c5cff; }
`;

const TODD_NOTES = `Todd's Notes (PRIVATE!!! do not read)
- ask Greg what a "rebase" is (he sighed. again)
- Dana said "let's take this offline". where is offline??
- wifi password is on the sticky note on Priya's monitor
- i think the coffee machine is sentient
`;

const LAZY = /^(fix|fixed|fixes|wip|update|updates|changes|stuff|asdf|test|typo|done|commit|\.)$/i;

export const level02: Level = {
  id: 'the-typo',
  ticket: 'CONG-1002',
  title: 'The Typo',
  clock: '2026-03-02 09:48',
  summary: 'Inspect changes, stage exactly one file, and write a real commit message.',
  concepts: ['git status', 'git diff', 'git add', 'git commit'],
  repo: 'website',
  hosted: 'conglomo/website',

  setup(b) {
    b.at('2026-01-12 14:00');
    const h = b.hub('conglomo', 'website', { description: 'conglomo.com — the face of synergy' });
    h.commit('main', { 'index.html': INDEX_TYPO.replace('Welcom to Conglomo', 'Coming soon'), 'styles.css': STYLES }, 'Initial website', AUTHORS.greg);
    h.commit('main', { 'index.html': INDEX_TYPO }, 'Add homepage copy from Marketing', AUTHORS.dana, { minutes: 60 * 26 });
    h.protect('main');
    b.clone(h);
    b.write('website', { 'index.html': INDEX_FIXED, 'todd_notes.txt': TODD_NOTES });
    b.cwd('website');
  },

  intro: [
    { from: 'dana', text: 'Ticket #2! 🎯 Todd fixed a typo on the homepage but left for the dentist before committing it. Classic Todd.' },
    { from: 'todd', text: 'sorry!!! 🦷 the fix is in index.html. please DON\'T look at todd_notes.txt, it\'s personal', delay: 800 },
    { from: 'greg', text: 'check what changed before you commit anything. `git status`, then `git diff`. trust nothing todd touches.' },
    { from: 'dana', text: 'Just commit the fix locally for now, with a proper message. Don\'t push yet: we have a process for that and I\'ll show you next. 🙂' },
  ],

  objectives: [
    {
      id: 'inspect',
      text: 'Inspect what changed (git status / git diff)',
      check: (p) => p.ranGit('status') || p.ranGit('diff'),
    },
    {
      id: 'commit',
      text: 'Commit Todd\'s fix to index.html',
      check: (p) => p.fileAt('HEAD', 'index.html') === INDEX_FIXED,
    },
    {
      id: 'message',
      text: 'Write a descriptive commit message',
      check: (p) => {
        if (p.fileAt('HEAD', 'index.html') !== INDEX_FIXED) return false;
        const s = p.subjects('HEAD', 1)[0] ?? '';
        return s.trim().length >= 10 && !LAZY.test(s.trim());
      },
    },
    {
      id: 'notes',
      text: 'Keep todd_notes.txt out of the commit',
      check: (p) => p.fileAt('HEAD', 'index.html') === INDEX_FIXED && !p.filesAt('HEAD').includes('todd_notes.txt'),
    },
  ],

  hints: [
    '`git status` shows a modified index.html and an *untracked* todd_notes.txt. Only one of those belongs in the commit.',
    'Stage just the one file: `git add index.html`. Run `git status` again. index.html should now be under “Changes to be committed”.',
    'Commit with a message that says what changed: `git commit -m "Fix typo in homepage heading"`',
    'Committed the notes by accident? `git rm --cached todd_notes.txt` unstages the file without deleting it, then `git commit --amend --no-edit` rewrites the commit.',
  ],

  reactions: [
    {
      id: 'notes-staged',
      when: (r) => !!r.probe.repo?.index.has('todd_notes.txt') && !r.probe.filesAt('HEAD').includes('todd_notes.txt'),
      say: [{ from: 'greg', text: '`git status`. look at what you just staged. `git add .` means *everything*. including a certain someone\'s diary.' }],
    },
    {
      id: 'notes-committed',
      when: (r) => r.probe.filesAt('HEAD').includes('todd_notes.txt'),
      say: [
        { from: 'todd', text: 'NOOOO you committed my notes 😱 can you undo that?? i googled it and it said `git rm --cached` and then `--amend`??' },
        { from: 'dana', text: 'I have now read Todd\'s notes. Todd, “offline” is not a place. Let\'s sync. 🙂', delay: 1500 },
      ],
    },
    {
      id: 'push-attempt',
      when: (r) => r.events.some((e) => e.type === 'push-rejected' && e.reason === 'protected'),
      say: [{ from: 'greg', text: '“protected branch hook declined”. that\'s github telling you main is off-limits. dana said don\'t push. listen to dana.' }],
    },
    {
      id: 'diffed',
      when: (r) => /^git diff\s*$/.test(r.command) && r.output.includes('Welcome'),
      say: [{ from: 'todd', text: 'see?? “Welcom” → “Welcome”. the red line is the old version and the green line is the new one 🤓' }],
    },
  ],

  outro: [
    { from: 'greg', text: 'one file. real message. you have already outperformed three previous hires.' },
    { from: 'todd', text: 'thank you for not committing my notes 🙏 (you didn\'t read them right)' },
    { from: 'dana', text: 'Great job! Next up: our branching process. 🌳' },
  ],

  debrief: {
    title: 'The three trees: working tree → index → commit',
    points: [
      'Your files on disk are the *working tree*. `git add` copies a file\'s current contents into the *index* (the staging area). `git commit` turns exactly what is staged into a permanent snapshot.',
      'Staging is how you choose what goes into a commit, which is why untracked files like Todd\'s notes never sneak in unless you add them.',
      '`git diff` shows unstaged changes; `git diff --staged` shows exactly what you\'re about to commit. Checking both is a great habit.',
      'A good message says what changed, in the imperative: “Fix typo in homepage heading”. Future you will search for it in `git log` during an outage.',
    ],
  },

  solution: ['git status', 'git diff', 'git add index.html', 'git commit -m "Fix typo in homepage heading"'],
  par: 2,
};
