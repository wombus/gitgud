/**
 * Fidelity harness: run the same scenario through real git and through the
 * simulator, normalize away things that legitimately differ (hashes, dates,
 * paths), and print a diff. Usage:
 *
 *   npx tsx scripts/crosscheck.ts [scenario-name]
 *
 * Requires a real `git` on PATH. This is a development tool, not a test: a few
 * differences are intentional (see docs/DESIGN.md).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '../src/engine/ansi';
import { myersDiff } from '../src/engine/diff';
import { officeTime } from '../src/engine/util';
import { World } from '../src/engine/world';
import { Shell } from '../src/shell/shell';
import { hostedCommit } from '../src/engine/hosted';

/** Lines starting with '@' are side-specific actions; $URL is the remote's URL. */
const scenarios: Record<string, string[]> = {
  remote: [
    '@seed',
    'git clone $URL app',
    'cd app',
    'git status',
    'git branch -a',
    'git remote -v',
    'echo "x" >> f.txt',
    'git commit -am "local"',
    'git status',
    'git push',
    'git status',
    'git checkout -b feature',
    'echo "y" > y.txt',
    'git add y.txt',
    'git commit -m "feature"',
    'git push',
    'git push -u origin feature',
    'git status',
    'git branch -vv',
    '@coworker',
    'git fetch',
    'git checkout main',
    'git status',
    'git pull',
    'git log --oneline --graph --all',
    'echo "z" >> f.txt',
    'git commit -am "mine"',
    '@coworker2',
    'git push',
    'git pull',
    'git pull --rebase',
    'git status',
    'git push',
    'git push origin --delete feature',
    'git branch -a',
  ],
  basics: [
    'mkdir proj',
    'cd proj',
    'git init',
    'git status',
    'echo "hello" > README.md',
    'git status',
    'git add README.md',
    'git status',
    'git commit -m "Initial commit"',
    'git status',
    'echo "world" >> README.md',
    'echo "x" > notes.txt',
    'git status',
    'git status -s',
    'git diff',
    'git add README.md',
    'git diff --staged',
    'git commit -m "Second"',
    'git log',
    'git log --oneline',
    'git rm notes.txt',
    'git add notes.txt',
    'git status',
  ],
  branching: [
    'mkdir proj',
    'cd proj',
    'git init',
    'echo "a" > a.txt',
    'git add .',
    'git commit -m "base"',
    'git branch feature',
    'git branch',
    'git switch feature',
    'echo "b" > b.txt',
    'git add b.txt',
    'git commit -m "feature work"',
    'git switch main',
    'echo "c" > c.txt',
    'git add c.txt',
    'git commit -m "main work"',
    'git merge feature -m "Merge branch \'feature\'"',
    'git log --oneline --graph --all',
    'git branch -d feature',
    'git branch -v',
  ],
  conflict: [
    'mkdir proj',
    'cd proj',
    'git init',
    'echo "line1" > f.txt',
    'echo "line2" >> f.txt',
    'echo "line3" >> f.txt',
    'git add .',
    'git commit -m "base"',
    'git checkout -b other',
    'echo "line1" > f.txt',
    'echo "THEIRS" >> f.txt',
    'echo "line3" >> f.txt',
    'git commit -am "theirs"',
    'git checkout main',
    'echo "line1" > f.txt',
    'echo "OURS" >> f.txt',
    'echo "line3" >> f.txt',
    'git commit -am "ours"',
    'git merge other',
    'git status',
    'cat f.txt',
    'git commit -m "try"',
    'echo "line1" > f.txt',
    'echo "RESOLVED" >> f.txt',
    'echo "line3" >> f.txt',
    'git add f.txt',
    'git status',
    'git commit --no-edit',
    'git log --oneline --graph',
  ],
  rebase: [
    'mkdir proj',
    'cd proj',
    'git init',
    'echo "1" > f.txt',
    'git add .',
    'git commit -m "one"',
    'git checkout -b feat',
    'echo "feat" > g.txt',
    'git add g.txt',
    'git commit -m "feat work"',
    'echo "2" >> f.txt',
    'git commit -am "feat edits f"',
    'git checkout main',
    'echo "main" >> f.txt',
    'git commit -am "main edits f"',
    'git checkout feat',
    'git rebase main',
    'git status',
    'echo "1" > f.txt',
    'echo "main" >> f.txt',
    'echo "2" >> f.txt',
    'git add f.txt',
    'git rebase --continue',
    'git log --oneline --graph --all',
  ],
  reset: [
    'mkdir proj',
    'cd proj',
    'git init',
    'echo "1" > f.txt',
    'git add .',
    'git commit -m "one"',
    'echo "2" >> f.txt',
    'git commit -am "two"',
    'echo "3" >> f.txt',
    'git commit -am "three"',
    'git reset --soft HEAD~1',
    'git status',
    'git reset HEAD~1',
    'git status',
    'git reset --hard HEAD',
    'git status',
    'git reflog',
    'git reset --hard HEAD@{2}',
    'git log --oneline',
  ],
  stash: [
    'mkdir proj',
    'cd proj',
    'git init',
    'echo "1" > f.txt',
    'git add .',
    'git commit -m "one"',
    'echo "wip" >> f.txt',
    'echo "new" > n.txt',
    'git add n.txt',
    'git stash',
    'git status',
    'git stash list',
    'git stash pop',
    'git stash list',
  ],
  picks: [
    'mkdir proj',
    'cd proj',
    'git init',
    'echo "1" > f.txt',
    'git add .',
    'git commit -m "one"',
    'git checkout -b hotfix',
    'echo "fix" > fix.txt',
    'git add fix.txt',
    'git commit -m "the fix"',
    'git checkout main',
    'git cherry-pick hotfix',
    'git revert HEAD --no-edit',
    'git log --oneline',
  ],
  detached: [
    'mkdir proj',
    'cd proj',
    'git init',
    'echo "1" > f.txt',
    'git add .',
    'git commit -m "one"',
    'echo "2" >> f.txt',
    'git commit -am "two"',
    'git checkout HEAD~1',
    'git status',
    'echo "x" > x.txt',
    'git add x.txt',
    'git commit -m "orphan"',
    'git branch',
    'git switch main',
  ],
  errors: [
    'mkdir proj',
    'cd proj',
    'git status',
    'git init',
    'git log',
    'git comit -m x',
    'git add nope.txt',
    'git checkout nope',
    'git switch nope',
    'echo "1" > f.txt',
    'git add .',
    'git commit -m "one"',
    'git branch "bad name"',
    'git checkout -b feature',
    'git branch -d feature',
    'git push',
    'git merge nothing',
  ],
};

const TRANSFER = /^(Enumerating objects|Counting objects|Delta compression|Compressing objects|Writing objects|Total \d|Unpacking objects|Receiving objects|Resolving deltas|remote: )/;

function normalize(s: string, home: string): string {
  return s
    .split('\n')
    .filter((l) => !TRANSFER.test(l))
    .join('\n')
    .split(`${home}/origin.git`)
    .join('URL')
    .split('github.com:conglomo/origin.git')
    .join('URL')
    .split('github.com:conglomo/origin')
    .join('URL')
    .split(home)
    .join('/home/junior')
    .replace(/\b[0-9a-f]{40}\b/g, 'HASH40')
    .replace(/\b[0-9a-f]{7,12}\b/g, 'HASH')
    .replace(/[A-Z][a-z]{2} [A-Z][a-z]{2} \d+ \d\d:\d\d:\d\d \d{4} [-+]\d{4}/g, 'DATE')
    .replace(/[ \t]+$/gm, '');
}

const REAL_ACTIONS: Record<string, string> = {
  '@seed':
    'git init -q --bare origin.git && git clone -q origin.git seed 2>/dev/null && (cd seed && echo "base" > f.txt && git add . && git commit -qm "base" && git push -q origin main) && rm -rf seed',
  '@coworker':
    '(git clone -q origin.git cw && cd cw && echo "cw" > cw.txt && git add . && git commit -qm "coworker" && git push -q) && rm -rf cw',
  '@coworker2':
    '(git clone -q origin.git cw && cd cw && echo "cw2" > cw2.txt && git add . && git commit -qm "coworker 2" && git push -q) && rm -rf cw',
};

function runReal(lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'gg-real-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    TERM: 'dumb',
    LANG: 'C',
  };
  execFileSync('git', ['config', '--global', 'user.name', 'Junior Dev'], { env });
  execFileSync('git', ['config', '--global', 'user.email', 'junior@conglomo.com'], { env });
  execFileSync('git', ['config', '--global', 'init.defaultBranch', 'main'], { env });
  execFileSync('git', ['config', '--global', 'advice.defaultBranchName', 'false'], { env });
  const script = lines
    .map((l) => {
      if (l.startsWith('@')) return `(cd "${home}" && ${REAL_ACTIONS[l]}) >/dev/null 2>&1`;
      const cmd = l.replace(/\$URL/g, `${home}/origin.git`);
      return `echo '$ ${l.replace(/'/g, `'\\''`)}'\n${cmd} 2>&1`;
    })
    .join('\n');
  writeFileSync(join(root, 's.sh'), `cd "${home}"\n${script}\n`);
  let out = '';
  try {
    out = execFileSync('bash', [join(root, 's.sh')], { env, encoding: 'utf8' });
  } catch (e) {
    out = (e as { stdout: string }).stdout;
  }
  rmSync(root, { recursive: true, force: true });
  return normalize(out, home).replace(/\n+$/, '');
}

async function runSim(lines: string[]): Promise<string> {
  const w = new World(officeTime('2026-03-02 09:00'));
  w.globalConfig.set('user.name', 'Junior Dev');
  w.globalConfig.set('user.email', 'junior@conglomo.com');
  const sh = new Shell(w, async (_f, c) => c);
  const parts: string[] = [];
  const cow = { name: 'Cow Orker', email: 'cow@conglomo.com' };
  for (const l of lines) {
    if (l === '@seed') {
      const host = w.hub.create('conglomo', 'origin');
      hostedCommit(w, host, 'main', { 'f.txt': 'base\n' }, 'base', cow);
      continue;
    }
    if (l === '@coworker' || l === '@coworker2') {
      const host = w.hub.resolve('conglomo/origin')!;
      const n = l === '@coworker' ? '' : '2';
      hostedCommit(w, host, 'main', { [`cw${n}.txt`]: `cw${n}\n` }, `coworker${n ? ' 2' : ''}`, cow);
      continue;
    }
    const r = await sh.run(l.replace(/\$URL/g, 'git@github.com:conglomo/origin.git'));
    parts.push(`$ ${l}`, ...r.lines.map(stripAnsi));
  }
  return normalize(parts.join('\n'), '/home/junior').replace(/\n+$/, '');
}

async function main() {
  const only = process.argv[2];
  let total = 0;
  for (const [name, lines] of Object.entries(scenarios)) {
    if (only && name !== only) continue;
    const real = runReal(lines).split('\n');
    const sim = (await runSim(lines)).split('\n');
    const ops = myersDiff(real, sim);
    const diffs = ops.filter((o) => o.op !== ' ').length;
    total += diffs;
    console.log(`\n=== ${name}: ${diffs ? `${diffs} differing lines` : 'identical'} ===`);
    if (diffs) {
      const verbose = process.argv.includes('-v');
      ops.forEach((o, i) => {
        const near = ops.slice(Math.max(0, i - 2), i + 3).some((x) => x.op !== ' ');
        if (o.op === ' ' && !(verbose && near)) return;
        console.log(`${o.op === '-' ? 'REAL' : o.op === '+' ? 'SIM ' : '    '} | ${o.text}`);
      });
    }
  }
  console.log(`\nTotal differing lines: ${total}`);
}

main();
