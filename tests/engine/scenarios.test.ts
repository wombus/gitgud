import { describe, expect, it } from 'vitest';
import { hostedCommit } from '../../src/engine/hosted';
import { newShell, newWorld, run } from '../helpers';

async function repoWithCommit() {
  const sh = newShell();
  await run(sh, 'mkdir app', 'cd app', 'git init', 'echo "hello" > README.md', 'git add .', 'git commit -m "init"');
  return sh;
}

describe('identity', () => {
  it('refuses to commit without user.name/email, like real git', async () => {
    const sh = newShell(newWorld({ identity: false }));
    const out = await run(sh, 'mkdir a', 'cd a', 'git init', 'touch x', 'git add x', 'git commit -m "x"');
    expect(out).toContain('Author identity unknown');
    await run(sh, 'git config --global user.name "Pat"', 'git config --global user.email pat@x.com');
    expect(await run(sh, 'git commit -m "x"')).toContain('(root-commit)');
  });
});

describe('staging and committing', () => {
  it('tracks the three trees through add/commit', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'echo "more" >> README.md');
    expect(await run(sh, 'git status -s')).toBe(' M README.md');
    await run(sh, 'git add README.md');
    expect(await run(sh, 'git status -s')).toBe('M  README.md');
    await run(sh, 'git commit -m "more"');
    expect(await run(sh, 'git status')).toContain('nothing to commit, working tree clean');
  });

  it('amend rewrites the last commit', async () => {
    const sh = await repoWithCommit();
    const before = sh.repo!.headHash();
    await run(sh, 'git commit --amend -m "better message"');
    expect(sh.repo!.headHash()).not.toBe(before);
    expect(await run(sh, 'git log --oneline')).toMatch(/^[0-9a-f]{7} \(HEAD -> main\) better message$/);
  });

  it('opens the editor when no -m is given', async () => {
    const sh = newShell(newWorld(), (_f, content) => `From the editor\n${content}`);
    await run(sh, 'mkdir a', 'cd a', 'git init', 'touch x', 'git add x');
    expect(await run(sh, 'git commit')).toContain('From the editor');
  });
});

describe('branching and merging', () => {
  it('produces conflict markers and resolves via add + commit', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'git switch -c feature', 'echo "feature" > README.md', 'git commit -am "f"', 'git switch main', 'echo "main" > README.md', 'git commit -am "m"');
    const out = await run(sh, 'git merge feature');
    expect(out).toContain('CONFLICT (content): Merge conflict in README.md');
    expect(await run(sh, 'cat README.md')).toBe('<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> feature');
    expect(sh.prompt()).toContain('MERGING');
    await run(sh, 'echo "both" > README.md', 'git add README.md', 'git commit --no-edit');
    expect(sh.repo!.parents(sh.repo!.headHash()!)).toHaveLength(2);
  });

  it('merge --abort restores the pre-merge state', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'git switch -c f', 'echo "a" > README.md', 'git commit -am a', 'git switch main', 'echo "b" > README.md', 'git commit -am b', 'git merge f', 'git merge --abort');
    expect(await run(sh, 'cat README.md')).toBe('b');
    expect(sh.repo!.op).toBeNull();
  });

  it('refuses to switch when local changes would be overwritten', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'git switch -c f', 'echo "f" > README.md', 'git commit -am f', 'git switch main', 'echo "dirty" > README.md');
    expect(await run(sh, 'git switch f')).toContain('would be overwritten by checkout');
  });

  it('warns about orphaned commits when leaving detached HEAD', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'git checkout HEAD', 'git checkout --detach', 'touch y', 'git add y', 'git commit -m "lost"');
    expect(await run(sh, 'git switch main')).toContain('you are leaving 1 commit behind');
  });
});

describe('rewriting history', () => {
  it('interactive rebase can squash commits', async () => {
    const sh = newShell(newWorld(), (file, content) =>
      file.includes('rebase-todo') ? content.replace(/^pick (\w+) three/m, 'squash $1 three') : content,
    );
    await run(sh, 'mkdir a', 'cd a', 'git init', 'echo 1 > f', 'git add .', 'git commit -m one');
    await run(sh, 'echo 2 >> f', 'git commit -am two', 'echo 3 >> f', 'git commit -am three', 'echo 4 >> f', 'git commit -am four');
    await run(sh, 'git rebase -i HEAD~3');
    const log = await run(sh, 'git log --format=%s');
    expect(log.split('\n')).toEqual(['four', 'two', 'one']);
    expect(await run(sh, 'cat f')).toBe('1\n2\n3\n4');
  });

  it('rejects squash as the first todo item, like git', async () => {
    const sh = newShell(newWorld(), (file, content) => (file.includes('rebase-todo') ? content.replace(/^pick/m, 'squash') : content));
    await run(sh, 'mkdir a', 'cd a', 'git init', 'echo 1 > f', 'git add .', 'git commit -m one', 'echo 2 >> f', 'git commit -am two');
    expect(await run(sh, 'git rebase -i HEAD~1')).toContain("cannot 'squash' without a previous commit");
  });

  it('reflog can recover commits lost to reset --hard', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'echo precious > p.txt', 'git add .', 'git commit -m "precious work"');
    const lost = sh.repo!.headHash()!;
    await run(sh, 'git reset --hard HEAD~1');
    expect(await run(sh, 'git reflog')).toContain('precious work');
    await run(sh, 'git reset --hard HEAD@{1}');
    expect(sh.repo!.headHash()).toBe(lost);
  });

  it('cherry-pick keeps the original author', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'git switch -c hf', 'echo fix > fix.txt', 'git add .', 'git commit -m fix --author="Greg <greg@conglomo.com>"', 'git switch main');
    await run(sh, 'git cherry-pick hf');
    expect(sh.repo!.objects.commit(sh.repo!.headHash()!).author.name).toBe('Greg');
  });

  it('revert creates an inverse commit', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'echo bad > bug.js', 'git add .', 'git commit -m "add bug"', 'git revert HEAD --no-edit');
    expect(await run(sh, 'ls')).toBe('README.md');
    expect(await run(sh, 'git log --format=%s -1')).toBe('Revert "add bug"');
  });
});

describe('stash', () => {
  it('stashes and restores including untracked files with -u', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'echo wip >> README.md', 'echo new > new.txt', 'git stash -u');
    expect(await run(sh, 'git status -s')).toBe('');
    await run(sh, 'git stash pop');
    expect(await run(sh, 'git status -s')).toBe(' M README.md\n?? new.txt');
  });
});

describe('remotes and GitHub', () => {
  function setup() {
    const w = newWorld();
    const host = w.hub.create('conglomo', 'app');
    const greg = { name: 'Greg', email: 'greg@conglomo.com' };
    hostedCommit(w, host, 'main', { 'README.md': 'hi\n' }, 'init', greg);
    const sh = newShell(w);
    return { w, host, greg, sh };
  }

  it('rejects a push when the remote moved, then succeeds after pull --rebase', async () => {
    const { w, host, greg, sh } = setup();
    await run(sh, 'git clone git@github.com:conglomo/app.git', 'cd app', 'echo x > x', 'git add x', 'git commit -m x');
    hostedCommit(w, host, 'main', { 'g.txt': 'g\n' }, 'greg', greg);
    expect(await run(sh, 'git push')).toContain('[rejected]        main -> main (fetch first)');
    await run(sh, 'git pull --rebase');
    expect(await run(sh, 'git push')).toMatch(/[0-9a-f]{7}\.\.[0-9a-f]{7}  main -> main/);
  });

  it('protected branches reject direct pushes', async () => {
    const { host, sh } = setup();
    host.protect('main');
    await run(sh, 'git clone git@github.com:conglomo/app.git', 'cd app', 'echo x > x', 'git add x', 'git commit -m x');
    expect(await run(sh, 'git push')).toContain('GH006: Protected branch update failed');
  });

  it('merging a PR with "Fixes #N" closes the issue', async () => {
    const { w, host, sh } = setup();
    const issue = host.openIssue({ title: 'Typo', body: 'fix it', author: 'dana', createdAt: w.clock.now() });
    await run(sh, 'git clone git@github.com:conglomo/app.git', 'cd app', 'git switch -c fix', 'echo fixed > README.md', 'git commit -am "Fix typo"', 'git push -u origin fix');
    expect(await run(sh, `gh pr create --title "Fix typo" --body "Fixes #${issue.number}"`)).toContain('/pull/');
    const out = await run(sh, 'gh pr merge --squash --delete-branch');
    expect(out).toContain('Squashed and merged pull request');
    expect(issue.state).toBe('closed');
    expect(sh.repo!.currentBranch()).toBe('main');
    expect(await run(sh, 'cat README.md')).toBe('fixed');
  });
});

describe('bisect', () => {
  it('finds the first bad commit with bisect run', async () => {
    const sh = await repoWithCommit();
    for (let i = 1; i <= 8; i++) {
      await run(sh, `echo "v${i}${i >= 6 ? ' BUG' : ''}" > app.js`, 'git add .', `git commit -m "change ${i}"`);
    }
    sh.world.testRunner = (repo) => {
      const bug = (repo.worktree.get('app.js') ?? '').includes('BUG');
      return { pass: !bug, output: bug ? 'FAIL' : 'PASS' };
    };
    await run(sh, 'git bisect start', 'git bisect bad', 'git bisect good HEAD~8');
    const out = await run(sh, 'git bisect run npm test');
    expect(out).toContain('is the first bad commit');
    expect(out).toContain('change 6');
  });
});

describe('shell', () => {
  it('supports pipes, redirection, chains and globs', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'echo "a" > one.js && echo "b" > two.js', 'git add *.js');
    expect(await run(sh, 'git status -s | wc -l')).toBe('2');
    expect(await run(sh, 'git log --oneline | grep init')).toMatch(/init$/);
    expect(await run(sh, 'false || echo recovered')).toBe('recovered');
  });

  it('treats rm -rf .git as the catastrophe it is', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'rm -rf .git');
    expect(sh.world.events.some((e) => e.type === 'rm-git')).toBe(true);
    expect(await run(sh, 'git status')).toContain('not a git repository');
  });

  it('tab-completes git subcommands and branch names', async () => {
    const sh = await repoWithCommit();
    await run(sh, 'git branch feature/login');
    expect(sh.complete('git chec').line).toBe('git checkout ');
    expect(sh.complete('git checkout feat').line).toBe('git checkout feature/login ');
  });
});
