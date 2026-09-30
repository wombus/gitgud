import { c } from './ansi';

/**
 * In-game help. Real git's man pages are famously dense; these entries give the
 * usage lines you actually need plus a plain-English "what it really does".
 */

interface HelpEntry {
  summary: string;
  usage: string[];
  explain: string[];
}

export const HELP: Record<string, HelpEntry> = {
  init: {
    summary: 'Create an empty Git repository',
    usage: ['git init [<directory>]'],
    explain: ['Creates a hidden .git folder: the database where every commit, branch and', 'config setting for this project will live.'],
  },
  clone: {
    summary: 'Clone a repository into a new directory',
    usage: ['git clone <url> [<directory>]'],
    explain: [
      'Downloads the whole history of a remote repository, sets it up as a remote',
      "called 'origin', and checks out its default branch for you.",
    ],
  },
  config: {
    summary: 'Get and set repository or global options',
    usage: ['git config --global user.name "Your Name"', 'git config --global user.email you@example.com', 'git config <key>', 'git config --list'],
    explain: ['Git stamps your name and email into every commit you make. --global sets', 'it for all repositories; without it, only for the current one.'],
  },
  status: {
    summary: 'Show the working tree status',
    usage: ['git status', 'git status -s   (short format)'],
    explain: [
      'Compares three snapshots: HEAD (your last commit), the index (what you have',
      'staged), and the working tree (your files). When lost, run this first.',
    ],
  },
  add: {
    summary: 'Add file contents to the index (stage them)',
    usage: ['git add <file>...', 'git add .        (everything in this directory)', 'git add -A       (everything, including deletions)'],
    explain: ['Copies the current contents of files into the staging area. The next', 'commit records exactly what is staged, not what is on disk.'],
  },
  rm: {
    summary: 'Remove files from the working tree and from the index',
    usage: ['git rm <file>', 'git rm --cached <file>   (stop tracking, keep the file on disk)'],
    explain: ['Stages a deletion. --cached is how you untrack a file you committed by', 'accident (like .env) without deleting your local copy.'],
  },
  mv: {
    summary: 'Move or rename a file',
    usage: ['git mv <source> <destination>'],
    explain: ['Renames the file on disk and stages the rename in one go.'],
  },
  commit: {
    summary: 'Record changes to the repository',
    usage: ['git commit -m "message"', 'git commit -am "message"   (stage tracked changes + commit)', 'git commit --amend          (rewrite the last commit)'],
    explain: [
      'Turns the index into a permanent snapshot, with you as the author, and moves',
      'the current branch forward to point at it. --amend replaces the last commit',
      "(new hash!), so don't amend commits you've already pushed.",
    ],
  },
  restore: {
    summary: 'Restore working tree files',
    usage: ['git restore <file>            (discard unstaged changes)', 'git restore --staged <file>   (unstage, keep changes)', 'git restore --source=<commit> <file>'],
    explain: ['The modern, less overloaded replacement for "git checkout -- <file>".', 'Discarding changes with it cannot be undone.'],
  },
  log: {
    summary: 'Show commit logs',
    usage: ['git log', 'git log --oneline --graph --all', 'git log -n 5', 'git log main..feature   (commits on feature not on main)'],
    explain: ['Walks history backwards from HEAD (or the refs you name). --graph draws', 'the branch structure; --all includes every branch, not just the current one.'],
  },
  show: {
    summary: 'Show a commit (or file at a commit)',
    usage: ['git show [<commit>]', 'git show <commit>:<path>'],
    explain: ['Shows the commit message and the diff it introduced.'],
  },
  diff: {
    summary: 'Show changes',
    usage: ['git diff              (working tree vs index: unstaged changes)', 'git diff --staged     (index vs HEAD: what will be committed)', 'git diff <a> <b>      (between two commits)'],
    explain: ['Lines starting with - were removed, lines starting with + were added.'],
  },
  branch: {
    summary: 'List, create, or delete branches',
    usage: ['git branch', 'git branch <name>', 'git branch -d <name>   (delete if merged)', 'git branch -D <name>   (delete anyway)', 'git branch -m <new>    (rename current)', 'git branch -vv         (show upstreams)'],
    explain: [
      'A branch is just a movable pointer to a commit. Creating one is instant and',
      'free. Deleting one only deletes the pointer, not the commits (at first).',
    ],
  },
  checkout: {
    summary: 'Switch branches or restore files (the old do-everything command)',
    usage: ['git checkout <branch>', 'git checkout -b <new-branch>', 'git checkout <commit>   (detached HEAD)', 'git checkout -- <file>'],
    explain: ['Does two unrelated jobs, which is why git 2.23 split it into "switch"', 'and "restore". Both styles work everywhere.'],
  },
  switch: {
    summary: 'Switch branches',
    usage: ['git switch <branch>', 'git switch -c <new-branch>', 'git switch -           (previous branch)', 'git switch --detach <commit>'],
    explain: ['Moves HEAD to another branch and updates your files to match. Uncommitted', 'changes come along if they do not conflict with the other branch.'],
  },
  merge: {
    summary: 'Join two development histories together',
    usage: ['git merge <branch>', 'git merge --no-ff <branch>', 'git merge --abort'],
    explain: [
      "If your branch hasn't moved, git just slides it forward (fast-forward).",
      'Otherwise it creates a merge commit with two parents. If both sides changed',
      'the same lines you get conflict markers to resolve by hand, then add+commit.',
    ],
  },
  rebase: {
    summary: 'Reapply commits on top of another base',
    usage: ['git rebase <upstream>', 'git rebase -i HEAD~3   (edit/squash/reorder recent commits)', 'git rebase --continue | --skip | --abort'],
    explain: [
      'Replays your commits one at a time onto a new base, creating NEW commits',
      '(new hashes) with the same changes. Gives linear history. Golden rule: never',
      'rebase commits other people already have.',
    ],
  },
  'cherry-pick': {
    summary: 'Apply the changes introduced by some existing commits',
    usage: ['git cherry-pick <commit>...', 'git cherry-pick -x <commit>   (note the original hash)', 'git cherry-pick --continue | --abort'],
    explain: ['Copies the change a commit made and commits it again on your current', 'branch. Great for getting one hotfix onto a release branch.'],
  },
  revert: {
    summary: 'Create a commit that undoes an earlier commit',
    usage: ['git revert <commit>', 'git revert -m 1 <merge-commit>'],
    explain: [
      "The safe way to undo something that's already pushed: history is not",
      'rewritten, a new commit simply applies the inverse change.',
    ],
  },
  reset: {
    summary: 'Move the current branch to another commit',
    usage: ['git reset --soft <commit>    (keep changes staged)', 'git reset <commit>           (keep changes unstaged)', 'git reset --hard <commit>    (THROW AWAY changes)', 'git reset <file>             (unstage a file)'],
    explain: [
      'Moves your branch pointer. --hard also overwrites your files. Commits you',
      'reset away are not deleted immediately: `git reflog` can find them.',
    ],
  },
  stash: {
    summary: 'Stash the changes in a dirty working directory away',
    usage: ['git stash               (save and clean your working tree)', 'git stash -u            (include untracked files)', 'git stash list', 'git stash pop           (re-apply and drop)', 'git stash apply         (re-apply, keep it)'],
    explain: ['A clipboard for uncommitted work. Perfect for "drop everything and fix', 'prod" moments.'],
  },
  tag: {
    summary: 'Create, list, or delete tags',
    usage: ['git tag', 'git tag v1.0', 'git tag -a v1.0 -m "Release 1.0"', 'git push origin v1.0'],
    explain: ['A tag is a branch that never moves. Used to mark releases.'],
  },
  remote: {
    summary: 'Manage tracked repositories',
    usage: ['git remote -v', 'git remote add <name> <url>', 'git remote show origin'],
    explain: ["A remote is a named URL. 'origin' is the conventional name for where you", 'cloned from.'],
  },
  fetch: {
    summary: 'Download objects and refs from another repository',
    usage: ['git fetch', 'git fetch --prune'],
    explain: [
      'Downloads new commits and updates remote-tracking branches like',
      'origin/main. Never touches your own branches or files: always safe.',
    ],
  },
  pull: {
    summary: 'Fetch and integrate with another repository',
    usage: ['git pull', 'git pull --rebase', 'git pull --ff-only'],
    explain: ['git fetch + git merge (or rebase with --rebase) of your upstream branch.'],
  },
  push: {
    summary: 'Update remote refs along with associated objects',
    usage: ['git push', 'git push -u origin <branch>   (first push of a new branch)', 'git push --force-with-lease   (the polite force push)', 'git push origin --delete <branch>'],
    explain: [
      'Uploads your commits and moves the branch on the remote. Rejected if the',
      'remote has commits you do not; --force overwrites them (and other people\'s',
      'work). Prefer --force-with-lease, which refuses if someone pushed meanwhile.',
    ],
  },
  reflog: {
    summary: 'Show where HEAD (or a branch) has been',
    usage: ['git reflog', 'git reflog show <branch>'],
    explain: [
      'A local diary of every commit HEAD has pointed at. The ultimate undo button:',
      'find the hash from before your mistake and `git reset --hard` or',
      '`git branch rescue <hash>` to get it back.',
    ],
  },
  blame: {
    summary: 'Show what revision and author last modified each line',
    usage: ['git blame <file>'],
    explain: ['Useful for finding context. Less useful for assigning actual blame.'],
  },
  bisect: {
    summary: 'Use binary search to find the commit that introduced a bug',
    usage: ['git bisect start', 'git bisect bad [<commit>]', 'git bisect good <commit>', 'git bisect run npm test', 'git bisect reset'],
    explain: ['Checks out the midpoint between a good and a bad commit; you test and', 'mark it; repeat. 1000 commits take about 10 steps.'],
  },
  clean: {
    summary: 'Remove untracked files from the working tree',
    usage: ['git clean -n    (dry run: show what would go)', 'git clean -f    (actually delete)', 'git clean -fd   (including directories)'],
    explain: ['Deletes files git does not track. There is no undo. Dry-run first.'],
  },
  shortlog: {
    summary: 'Summarize git log output by author',
    usage: ['git shortlog -sn'],
    explain: ['Who wrote how many commits. Politically sensitive at review time.'],
  },
};

export function commandHelp(cmd: string): string[] | null {
  const h = HELP[cmd];
  if (!h) return null;
  return [
    c.bold(`git ${cmd}`) + ` - ${h.summary}`,
    '',
    c.bold('USAGE'),
    ...h.usage.map((u) => `    ${u}`),
    '',
    c.bold('WHAT IT ACTUALLY DOES'),
    ...h.explain.map((e) => `    ${e}`),
  ];
}

export function generalHelp(): string[] {
  const group = (title: string, cmds: string[]) => [
    title,
    ...cmds.filter((k) => HELP[k]).map((k) => `   ${k.padEnd(12)} ${HELP[k].summary}`),
    '',
  ];
  return [
    'usage: git [--version] [--help] <command> [<args>]',
    '',
    'These are common Git commands used in various situations:',
    '',
    ...group('start a working area', ['clone', 'init']),
    ...group('work on the current change', ['add', 'mv', 'restore', 'rm']),
    ...group('examine the history and state', ['bisect', 'diff', 'log', 'show', 'status', 'blame', 'reflog']),
    ...group('grow, mark and tweak your common history', ['branch', 'commit', 'merge', 'rebase', 'reset', 'switch', 'tag', 'cherry-pick', 'revert', 'stash']),
    ...group('collaborate', ['fetch', 'pull', 'push', 'remote']),
    "'git help <command>' explains a command in plain English.",
  ];
}
