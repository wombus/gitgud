import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/engine/ansi';
import { Director, type LevelReport } from '../../src/game/director';
import type { Incident, Level } from '../../src/game/types';
import { LEVELS } from '../../src/game/levels';

/**
 * Every level must be (1) not already solved at the start and (2) solvable by its
 * scripted solution. This catches broken setups and typos in objectives.
 */

function makeDirector(level: Level) {
  let report: LevelReport | null = null;
  let incident: Incident | null = null;
  const d = new Director(level, {
    identity: { name: 'Test Player', email: 'test@conglomo.com' },
    editor: async (file, content) => {
      const edit = Object.entries(level.solutionEdits ?? {}).find(([k]) => file.endsWith(k));
      return edit ? edit[1](content) : content;
    },
    scheduler: (fn) => fn(),
    pace: 0,
    callbacks: {
      onComplete: (r) => (report = r),
      onFail: (i) => (incident = i),
    },
  });
  return { d, report: () => report, incident: () => incident };
}

function fill(cmd: string, data: Record<string, string>): string {
  return cmd.replace(/\{\{(\w+)\}\}/g, (_, k) => data[k] ?? `{{${k}}}`);
}

describe.each(LEVELS.map((l) => [l.id, l] as const))('level %s', (_id, level) => {
  it('starts unsolved and is solved by its scripted solution', async () => {
    const h = makeDirector(level);
    await h.d.start();
    const initial = h.d.objectiveStatus();
    expect(initial.every((o) => o.done), 'level is already solved at start').toBe(false);

    const transcript: string[] = [];
    for (const raw of level.solution) {
      const cmd = fill(raw, h.d.world.data);
      const r = await h.d.runCommand(cmd);
      transcript.push(`$ ${cmd}`, ...r.lines.map(stripAnsi));
    }
    const status = h.d.objectiveStatus();
    const missing = status.filter((o) => !o.done).map((o) => o.text);
    expect(missing, `unsolved objectives. transcript:\n${transcript.join('\n')}`).toEqual([]);
    expect(h.incident()).toBeNull();
    expect(h.report()?.rating).toBeDefined();
  });

  it('has hints, a debrief and a sensible par', () => {
    expect(level.hints.length).toBeGreaterThan(0);
    expect(level.debrief.points.length).toBeGreaterThan(1);
    expect(level.par).toBeGreaterThan(0);
  });
});

describe('campaign', () => {
  it('has unique ids and tickets', () => {
    expect(new Set(LEVELS.map((l) => l.id)).size).toBe(LEVELS.length);
    expect(new Set(LEVELS.map((l) => l.ticket)).size).toBe(LEVELS.length);
  });
});

/* ------------------------------------------------------------------------ */
/* Other valid ways to win, and the mistakes that must end a ticket.         */
/* ------------------------------------------------------------------------ */

type Path = { commands: string[]; edits?: Record<string, (c: string) => string> };

const ALTERNATIVES: Record<string, Record<string, Path>> = {
  'the-typo': {
    'commit the notes, then fix with rm --cached + amend': {
      commands: ['git status', 'git add .', 'git commit -m "Fix typo in homepage heading"', 'git rm --cached todd_notes.txt', 'git commit --amend --no-edit'],
    },
  },
  'branch-out': {
    'commit on main, then move it': {
      commands: [
        'git add newsletter.html',
        'git commit -m "Add newsletter signup page"',
        'git branch feature/newsletter-signup',
        'git reset --hard origin/main',
        'git switch feature/newsletter-signup',
        'git push -u origin feature/newsletter-signup',
      ],
    },
    'checkout -b and a failed push first': {
      commands: ['git checkout -b feature/newsletter-signup', 'git add .', 'git commit -m "Add newsletter signup page"', 'git push', 'git push --set-upstream origin feature/newsletter-signup'],
    },
  },
  'pull-request': {
    'fill, forget the link, edit it, merge and clean up by hand': {
      commands: [
        'gh pr create --fill',
        'gh pr edit --body "Closes #7"',
        'gh pr merge --squash',
        'git switch main',
        'git pull',
        'git branch -d feature/newsletter-signup',
        'git branch -D feature/newsletter-signup',
      ],
    },
  },
  'merge-conflict': {
    'rebase instead of merge': {
      commands: ['git fetch', 'git rebase origin/main', 'nano config.yml', 'git add config.yml', 'git rebase --continue', 'git push --force-with-lease'],
    },
    'pull with an explicit strategy, commit via editor': {
      commands: ['git pull --no-rebase origin main', 'nano config.yml', 'git add config.yml', 'git commit', 'git push'],
    },
  },
  'hotfix-stash': {
    'WIP commit instead of stash': {
      commands: ['git add .', 'git commit -m "WIP reports"', 'git switch main', 'git pull', 'nano login.js', 'git commit -am "Fix password check"', 'git push', 'git switch feature/reports', 'git reset HEAD~1'],
    },
  },
  revert: {
    'undo by hand with an edit': {
      commands: ['git show HEAD~2', 'nano money.js', 'git commit -am "Restore correct rounding"', 'git push'],
      edits: { 'money.js': (c) => c.replace('return Math.floor(amount); // simpler!!', 'return Math.round(amount * 100) / 100;') },
    },
  },
  squash: {
    'interactive rebase with fixups': {
      commands: ['git rebase -i main', 'git commit --amend -m "Add price and stock filters to search"', 'git push --force-with-lease'],
      edits: { 'git-rebase-todo': (c) => c.split('\n').map((l, i) => (i > 0 && l.startsWith('pick') ? l.replace('pick', 'fixup') : l)).join('\n') },
    },
  },
  reflog: {
    'rescue branch + merge': {
      commands: ['git reflog', 'git branch rescue HEAD@{1}', 'git merge rescue', 'git push'],
    },
  },
  secrets: {
    'soft reset and recommit': {
      commands: ['git reset --soft HEAD~1', 'git rm --cached .env', 'echo ".env" >> .gitignore', 'git add .gitignore', 'git commit -m "Handle Stripe payment webhooks"', 'git push'],
    },
  },
  'friday-release': {
    'rescue via a branch name': {
      commands: ['git rebase --abort', 'git branch todd-fix {{fix}}', 'git cherry-pick todd-fix', 'git push', 'git tag v4.0.0', 'git push --tags'],
    },
  },
};

const FAILURES: Record<string, Record<string, { commands: string[]; incident: RegExp }>> = {
  'the-typo': { 'rm -rf .git': { commands: ['rm -rf .git'], incident: /Repository Deleted/ } },
  'hotfix-stash': {
    'dropping the stash': { commands: ['git stash -u', 'git stash drop'], incident: /Destroyed/ },
    'discarding the WIP': { commands: ['git restore reports.js'], incident: /Destroyed/ },
  },
  revert: { 'reset + force push': { commands: ['git reset --hard HEAD~3', 'git push --force'], incident: /Shared History Rewritten/ } },
  'cherry-pick': { 'merging main into the release': { commands: ['git switch release/2.4', 'git merge main', 'git push'], incident: /Unreleased Features/ } },
  secrets: { 'pushing the key': { commands: ['git push'], incident: /Credentials Leaked/ } },
  'friday-release': {
    'force-pushing the release': { commands: ['git rebase --abort', 'git reset --hard HEAD~1', 'git push --force'], incident: /Release Branch Rewritten/ },
  },
};

async function play(level: Level, path: Path) {
  const h = makeDirector({ ...level, solutionEdits: { ...(level.solutionEdits ?? {}), ...(path.edits ?? {}) } });
  await h.d.start();
  const transcript: string[] = [];
  for (const raw of path.commands) {
    const cmd = fill(raw, h.d.world.data);
    const r = await h.d.runCommand(cmd);
    transcript.push(`$ ${cmd}`, ...r.lines.map(stripAnsi));
  }
  return { h, transcript: transcript.join('\n') };
}

describe('alternative solutions', () => {
  for (const [id, paths] of Object.entries(ALTERNATIVES)) {
    for (const [name, path] of Object.entries(paths)) {
      it(`${id}: ${name}`, async () => {
        const level = LEVELS.find((l) => l.id === id)!;
        const { h, transcript } = await play(level, path);
        const missing = h.d.objectiveStatus().filter((o) => !o.done).map((o) => o.text);
        expect(missing, transcript).toEqual([]);
        expect(h.incident(), transcript).toBeNull();
      });
    }
  }
});

describe('failure paths', () => {
  for (const [id, cases] of Object.entries(FAILURES)) {
    for (const [name, f] of Object.entries(cases)) {
      it(`${id}: ${name}`, async () => {
        const level = LEVELS.find((l) => l.id === id)!;
        const { h, transcript } = await play(level, { commands: f.commands });
        expect(h.incident()?.title, transcript).toMatch(f.incident);
      });
    }
  }
});
