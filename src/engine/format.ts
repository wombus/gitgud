import { c } from './ansi';
import { countChanges, hunkHeader, myersDiff, splitLines, toHunks } from './diff';
import { shortHash, subject, type FileMap, type Hash } from './objects';
import { ZERO_HASH, type Repository } from './repo';
import { gitDate, plural } from './util';

/* ------------------------------------------------------------------------- */
/* Decorations: "(HEAD -> main, tag: v1.0, origin/main)"                      */
/* ------------------------------------------------------------------------- */

export function decorations(repo: Repository, hash: Hash): string[] {
  const heads: string[] = [];
  const remotes: string[] = [];
  const tags: string[] = [];
  const all: Array<[string, Hash]> = [...repo.refs];
  for (const [sym, target] of repo.symrefs) {
    const h = repo.refs.get(target);
    if (h) all.push([sym, h]);
  }
  for (const [ref, h] of all) {
    if (repo.objects.peel(h) !== hash) continue;
    if (ref.startsWith('refs/heads/')) heads.push(ref.slice(11));
    else if (ref.startsWith('refs/remotes/')) remotes.push(ref.slice(13));
    else if (ref.startsWith('refs/tags/')) tags.push(ref.slice(10));
  }
  const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
  heads.sort(desc);
  remotes.sort(desc);
  tags.sort(desc);

  const out: string[] = [];
  const cur = repo.currentBranch();
  const headHere = repo.headHash() === hash;
  if (headHere && cur && heads.includes(cur)) {
    out.push(`${c.boldCyan('HEAD ->')} ${c.boldGreen(cur)}`);
    heads.splice(heads.indexOf(cur), 1);
  } else if (headHere && repo.head.kind === 'detached') {
    out.push(c.boldCyan('HEAD'));
  }
  for (const t of tags) out.push(c.boldYellow(`tag: ${t}`));
  for (const r of remotes) out.push(c.boldRed(r));
  for (const h of heads) out.push(c.boldGreen(h));
  return out;
}

export function decorationSuffix(repo: Repository, hash: Hash): string {
  const d = decorations(repo, hash);
  return d.length ? ` ${c.yellow('(')}${d.join(c.yellow(', '))}${c.yellow(')')}` : '';
}

/* ------------------------------------------------------------------------- */
/* File-level diffs                                                           */
/* ------------------------------------------------------------------------- */

export interface FileDiff {
  status: 'A' | 'M' | 'D' | 'R';
  path: string;
  oldPath?: string;
  oldHash?: Hash;
  newHash?: Hash;
}

/** Compare two snapshots (path -> blob hash), with exact-content rename detection. */
export function diffFileMaps(from: FileMap, to: FileMap, opts: { renames?: boolean } = {}): FileDiff[] {
  const out: FileDiff[] = [];
  const added: FileDiff[] = [];
  const deleted: FileDiff[] = [];
  for (const p of new Set([...from.keys(), ...to.keys()])) {
    const a = from.get(p);
    const b = to.get(p);
    if (a === b) continue;
    if (a === undefined) added.push({ status: 'A', path: p, newHash: b });
    else if (b === undefined) deleted.push({ status: 'D', path: p, oldHash: a });
    else out.push({ status: 'M', path: p, oldHash: a, newHash: b });
  }
  if (opts.renames !== false) {
    for (const d of [...deleted]) {
      const match = added.find((a) => a.newHash === d.oldHash);
      if (match) {
        out.push({ status: 'R', path: match.path, oldPath: d.path, oldHash: d.oldHash, newHash: match.newHash });
        deleted.splice(deleted.indexOf(d), 1);
        added.splice(added.indexOf(match), 1);
      }
    }
  }
  out.push(...added, ...deleted);
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

function content(repo: Repository, h: Hash | undefined): string {
  return h === undefined ? '' : repo.blob(h);
}

export function formatPatch(repo: Repository, diffs: FileDiff[]): string[] {
  const lines: string[] = [];
  for (const d of diffs) {
    const oldPath = d.oldPath ?? d.path;
    lines.push(c.bold(`diff --git a/${oldPath} b/${d.path}`));
    if (d.status === 'A') lines.push(c.bold('new file mode 100644'));
    if (d.status === 'D') lines.push(c.bold('deleted file mode 100644'));
    if (d.status === 'R') {
      lines.push(c.bold('similarity index 100%'));
      lines.push(c.bold(`rename from ${oldPath}`));
      lines.push(c.bold(`rename to ${d.path}`));
      continue;
    }
    const oh = shortHash(d.oldHash ?? ZERO_HASH);
    const nh = shortHash(d.newHash ?? ZERO_HASH);
    lines.push(c.bold(`index ${oh}..${nh}${d.status === 'M' ? ' 100644' : ''}`));
    lines.push(c.bold(d.status === 'A' ? '--- /dev/null' : `--- a/${oldPath}`));
    lines.push(c.bold(d.status === 'D' ? '+++ /dev/null' : `+++ b/${d.path}`));
    const ops = myersDiff(splitLines(content(repo, d.oldHash)), splitLines(content(repo, d.newHash)));
    for (const h of toHunks(ops)) {
      lines.push(c.cyan(hunkHeader(h)));
      for (const o of h.ops) {
        if (o.op === '+') lines.push(c.green(`+${o.text}`));
        else if (o.op === '-') lines.push(c.red(`-${o.text}`));
        else lines.push(` ${o.text}`);
      }
    }
  }
  return lines;
}

export interface Totals {
  files: number;
  ins: number;
  del: number;
}

export function diffTotals(repo: Repository, diffs: FileDiff[]): Totals & { per: Map<FileDiff, { ins: number; del: number }> } {
  let ins = 0;
  let del = 0;
  const per = new Map<FileDiff, { ins: number; del: number }>();
  for (const d of diffs) {
    const ch = countChanges(content(repo, d.oldHash), content(repo, d.newHash));
    per.set(d, ch);
    ins += ch.ins;
    del += ch.del;
  }
  return { files: diffs.length, ins, del, per };
}

export function totalsLine(t: Totals): string {
  let s = ` ${plural(t.files, 'file')} changed`;
  if (t.ins || !t.del) s += `, ${plural(t.ins, 'insertion')}(+)`;
  if (t.del) s += `, ${plural(t.del, 'deletion')}(-)`;
  return s;
}

/** The ` file | 3 ++-` block used by merge, pull, and `--stat`. */
export function formatStat(repo: Repository, diffs: FileDiff[]): string[] {
  if (!diffs.length) return [];
  const t = diffTotals(repo, diffs);
  const names = diffs.map((d) => (d.status === 'R' ? `${d.oldPath} => ${d.path}` : d.path));
  const nameW = Math.max(...names.map((n) => n.length));
  const counts = diffs.map((d) => {
    const p = t.per.get(d)!;
    return p.ins + p.del;
  });
  const countW = Math.max(...counts.map((n) => String(n).length));
  const maxCount = Math.max(...counts, 1);
  const barMax = Math.max(10, 60 - nameW - countW);
  const lines = diffs.map((d, i) => {
    const p = t.per.get(d)!;
    const scale = maxCount > barMax ? barMax / maxCount : 1;
    const plus = Math.round(p.ins * scale) || (p.ins ? 1 : 0);
    const minus = Math.round(p.del * scale) || (p.del ? 1 : 0);
    const bar = c.green('+'.repeat(plus)) + c.red('-'.repeat(minus));
    return ` ${names[i].padEnd(nameW)} | ${String(counts[i]).padStart(countW)}${bar ? ' ' + bar : ''}`;
  });
  lines.push(totalsLine(t));
  return lines;
}

/** Diffstat plus create/delete mode lines, as printed by merge and pull. */
export function mergeSummary(repo: Repository, diffs: FileDiff[]): string[] {
  const lines = formatStat(repo, diffs);
  for (const d of diffs) {
    if (d.status === 'A') lines.push(` create mode 100644 ${d.path}`);
    else if (d.status === 'D') lines.push(` delete mode 100644 ${d.path}`);
    else if (d.status === 'R') lines.push(` rename ${d.oldPath} => ${d.path} (100%)`);
  }
  return lines;
}

/** Summary printed after `git commit`: totals plus create/delete/rename lines. */
export function commitSummary(repo: Repository, diffs: FileDiff[]): string[] {
  const lines = [totalsLine(diffTotals(repo, diffs))];
  for (const d of diffs) {
    if (d.status === 'A') lines.push(` create mode 100644 ${d.path}`);
    else if (d.status === 'D') lines.push(` delete mode 100644 ${d.path}`);
    else if (d.status === 'R') lines.push(` rename ${d.oldPath} => ${d.path} (100%)`);
  }
  return lines;
}

/* ------------------------------------------------------------------------- */
/* Commit headers                                                             */
/* ------------------------------------------------------------------------- */

export function indentMessage(message: string): string[] {
  const lines = message.replace(/\n+$/, '').split('\n');
  return lines.map((l) => (l ? `    ${l}` : ''));
}

export function commitHeader(repo: Repository, h: Hash, opts: { decorate?: boolean } = {}): string[] {
  const co = repo.objects.commit(h);
  const lines = [c.yellow(`commit ${h}`) + (opts.decorate !== false ? decorationSuffix(repo, h) : '')];
  if (co.parents.length > 1) lines.push(`Merge: ${co.parents.map(shortHash).join(' ')}`);
  lines.push(`Author: ${co.author.name} <${co.author.email}>`);
  lines.push(`Date:   ${gitDate(co.author.time)}`);
  lines.push('');
  lines.push(...indentMessage(co.message));
  return lines;
}

export function onelineCommit(repo: Repository, h: Hash, decorate = true): string {
  const co = repo.objects.commit(h);
  return `${c.yellow(shortHash(h))}${decorate ? decorationSuffix(repo, h) : ''} ${subject(co.message)}`;
}

/* ------------------------------------------------------------------------- */
/* Tracking info: "Your branch is ahead of 'origin/main' by 2 commits."       */
/* ------------------------------------------------------------------------- */

export function trackingInfo(repo: Repository, branch: string): string[] {
  const up = repo.upstreamOf(branch);
  if (!up) return [];
  const upName = `${up.remote}/${up.branch}`;
  const local = repo.branchHash(branch);
  const remote = repo.getRef(up.ref);
  if (!remote) {
    return [
      `Your branch is based on '${upName}', but the upstream is gone.`,
      `  (use "git branch --unset-upstream" to fixup)`,
    ];
  }
  if (!local) return [];
  const ahead = repo.rangeCount(remote, local);
  const behind = repo.rangeCount(local, remote);
  if (!ahead && !behind) return [`Your branch is up to date with '${upName}'.`];
  if (ahead && !behind)
    return [
      `Your branch is ahead of '${upName}' by ${plural(ahead, 'commit')}.`,
      `  (use "git push" to publish your local commits)`,
    ];
  if (!ahead && behind)
    return [
      `Your branch is behind '${upName}' by ${plural(behind, 'commit')}, and can be fast-forwarded.`,
      `  (use "git pull" to update your local branch)`,
    ];
  return [
    `Your branch and '${upName}' have diverged,`,
    `and have ${ahead} and ${behind} different commits each, respectively.`,
    `  (use "git pull" if you want to integrate the remote branch with yours)`,
  ];
}

export function aheadBehind(repo: Repository, branch: string): { ahead: number; behind: number; gone: boolean } | null {
  const up = repo.upstreamOf(branch);
  if (!up) return null;
  const local = repo.branchHash(branch);
  const remote = repo.getRef(up.ref);
  if (!remote) return { ahead: 0, behind: 0, gone: true };
  if (!local) return null;
  return { ahead: repo.rangeCount(remote, local), behind: repo.rangeCount(local, remote), gone: false };
}

/* ------------------------------------------------------------------------- */
/* git status (long format)                                                   */
/* ------------------------------------------------------------------------- */

const STAGED_LABEL: Record<string, string> = {
  A: 'new file:   ',
  M: 'modified:   ',
  D: 'deleted:    ',
  R: 'renamed:    ',
};

export function headLine(repo: Repository): string[] {
  const lines: string[] = [];
  const op = repo.op;
  if (op?.kind === 'rebase') {
    lines.push(`interactive rebase in progress; onto ${shortHash(op.onto)}`);
    return lines;
  }
  const branch = repo.currentBranch();
  if (branch) {
    lines.push(`On branch ${branch}`);
  } else {
    const h = repo.headHash()!;
    const d = repo.detachedFrom;
    if (d && d.hash === h) lines.push(c.red(`HEAD detached at ${d.label}`));
    else if (d) lines.push(c.red(`HEAD detached from ${d.label}`));
    else lines.push(c.red(`HEAD detached at ${shortHash(h)}`));
  }
  return lines;
}

export function formatLongStatus(repo: Repository): string[] {
  // Mirrors git's wt-status.c: header lines, then blocks that each END with a
  // blank line (not start with one), then a one-line summary if nothing is staged.
  const out = headLine(repo);
  const branch = repo.currentBranch();
  const s = repo.status();
  const op = repo.op;

  if (branch) {
    const ti = trackingInfo(repo, branch);
    if (ti.length) out.push(...ti, '');
  }

  if (!repo.headHash()) out.push('', 'No commits yet', '');

  if (op?.kind === 'merge' && !op.squash) {
    if (s.unmerged.length) {
      out.push('You have unmerged paths.', '  (fix conflicts and run "git commit")', '  (use "git merge --abort" to abort the merge)', '');
    } else {
      out.push('All conflicts fixed but you are still merging.', '  (use "git commit" to conclude merge)', '');
    }
  } else if (op?.kind === 'cherry-pick' || op?.kind === 'revert') {
    const verb = op.kind === 'cherry-pick' ? 'cherry-picking' : 'reverting';
    out.push(`You are currently ${verb} commit ${shortHash(op.current)}.`);
    if (s.unmerged.length) out.push(`  (fix conflicts and run "git ${op.kind} --continue")`);
    else out.push(`  (all conflicts fixed: run "git ${op.kind} --continue")`);
    out.push(`  (use "git ${op.kind} --skip" to skip this patch)`);
    out.push(`  (use "git ${op.kind} --abort" to cancel the ${op.kind} operation)`, '');
  } else if (op?.kind === 'rebase') {
    const who = op.headName ? `branch '${op.headName}'` : 'detached HEAD';
    const doneList = [...op.done, ...(op.current ? [op.current] : [])];
    if (doneList.length) {
      const n = doneList.length;
      out.push(n === 1 ? 'Last command done (1 command done):' : `Last commands done (${n} commands done):`);
      for (const d of doneList.slice(-2)) out.push(`   ${d.action} ${shortHash(d.commit)} ${subjectOf(repo, d.commit)}`);
      if (n > 2) out.push('  (see more in file .git/rebase-merge/done)');
    }
    if (op.todo.length) {
      out.push(`Next command${op.todo.length === 1 ? '' : 's'} to do (${op.todo.length} remaining command${op.todo.length === 1 ? '' : 's'}):`);
      for (const t of op.todo.slice(0, 2)) out.push(`   ${t.action} ${shortHash(t.commit)} ${subjectOf(repo, t.commit)}`);
      out.push('  (use "git rebase --edit-todo" to view and edit)');
    } else out.push('No commands remaining.');
    if (op.stopReason === 'edit') {
      out.push(`You are currently editing a commit while rebasing ${who} on '${shortHash(op.onto)}'.`);
      out.push('  (use "git commit --amend" to amend the current commit)');
      out.push('  (use "git rebase --continue" once you are satisfied with your changes)', '');
    } else {
      out.push(`You are currently rebasing ${who} on '${shortHash(op.onto)}'.`);
      if (s.unmerged.length) out.push('  (fix conflicts and then run "git rebase --continue")');
      else out.push('  (all conflicts fixed: run "git rebase --continue")');
      out.push('  (use "git rebase --skip" to skip this patch)');
      out.push('  (use "git rebase --abort" to check out the original branch)', '');
    }
  }
  if (repo.bisect) {
    const ob = repo.bisect.originalHead;
    out.push(
      `You are currently bisecting, started from branch '${ob.kind === 'branch' ? ob.name : shortHash(ob.hash)}'.`,
      '  (use "git bisect reset" to get back to the original branch)',
      '',
    );
  }

  if (s.staged.length) {
    out.push('Changes to be committed:');
    if (!op || op.kind === 'rebase') {
      out.push(repo.headHash() ? '  (use "git restore --staged <file>..." to unstage)' : '  (use "git rm --cached <file>..." to unstage)');
    }
    for (const e of s.staged) {
      const label = e.status === 'R' ? `${e.from} -> ${e.path}` : e.path;
      out.push(`\t${c.green(STAGED_LABEL[e.status] + label)}`);
    }
    out.push('');
  }
  if (s.unmerged.length) {
    out.push('Unmerged paths:');
    if (!op || op.kind === 'rebase') out.push('  (use "git restore --staged <file>..." to unstage)');
    out.push('  (use "git add <file>..." to mark resolution)');
    for (const u of s.unmerged) out.push(`\t${c.red(`${u.label}:`.padEnd(17) + u.path)}`);
    out.push('');
  }
  if (s.unstaged.length) {
    out.push('Changes not staged for commit:');
    const anyDeleted = s.unstaged.some((u) => u.status === 'D');
    out.push(`  (use "git add${anyDeleted ? '/rm' : ''} <file>..." to update what will be committed)`);
    out.push('  (use "git restore <file>..." to discard changes in working directory)');
    for (const u of s.unstaged) out.push(`\t${c.red(STAGED_LABEL[u.status] + u.path)}`);
    out.push('');
  }
  if (s.untracked.length) {
    out.push('Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
    for (const u of s.untracked) out.push(`\t${c.red(u)}`);
    out.push('');
  }

  if (s.staged.length) return out;
  if (s.unstaged.length || s.unmerged.length) out.push('no changes added to commit (use "git add" and/or "git commit -a")');
  else if (s.untracked.length) out.push('nothing added to commit but untracked files present (use "git add" to track)');
  else if (!repo.headHash()) out.push('nothing to commit (create/copy files and use "git add" to track)');
  else out.push('nothing to commit, working tree clean');
  return out;
}

function subjectOf(repo: Repository, h: Hash): string {
  return subject(repo.objects.commit(h).message);
}

export function formatShortStatus(repo: Repository, withBranch: boolean): string[] {
  const out: string[] = [];
  if (withBranch) {
    const b = repo.currentBranch();
    if (!b) out.push(`## ${c.red('HEAD (no branch)')}`);
    else {
      let line = `## ${c.green(b)}`;
      if (!repo.headHash()) line = `## No commits yet on ${c.green(b)}`;
      const up = repo.upstreamOf(b);
      if (up) {
        line += `...${c.red(`${up.remote}/${up.branch}`)}`;
        const ab = aheadBehind(repo, b);
        if (ab?.gone) line += ' [gone]';
        else if (ab && (ab.ahead || ab.behind)) {
          const parts: string[] = [];
          if (ab.ahead) parts.push(`ahead ${c.green(String(ab.ahead))}`);
          if (ab.behind) parts.push(`behind ${c.red(String(ab.behind))}`);
          line += ` [${parts.join(', ')}]`;
        }
      }
      out.push(line);
    }
  }
  const s = repo.status();
  const rows = new Map<string, { x: string; y: string; label: string }>();
  for (const e of s.staged) rows.set(e.path, { x: e.status, y: ' ', label: e.status === 'R' ? `${e.from} -> ${e.path}` : e.path });
  for (const u of s.unstaged) {
    const r = rows.get(u.path) ?? { x: ' ', y: ' ', label: u.path };
    r.y = u.status;
    rows.set(u.path, r);
  }
  for (const u of s.unmerged) rows.set(u.path, { x: u.code[0], y: u.code[1], label: u.path });
  const sorted = [...rows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [path, r] of sorted) {
    if (s.unmerged.some((u) => u.path === path)) out.push(`${c.red(r.x + r.y)} ${r.label}`);
    else out.push(`${c.green(r.x)}${c.red(r.y)} ${r.label}`);
  }
  for (const u of s.untracked) out.push(`${c.red('??')} ${u}`);
  return out;
}

/** The commit-message template shown in the editor for `git commit`. */
export function commitTemplate(repo: Repository, initial = ''): string {
  const lines = [
    initial,
    '# Please enter the commit message for your changes. Lines starting',
    "# with '#' will be ignored, and an empty message aborts the commit.",
    '#',
  ];
  for (const l of formatLongStatus(repo)) {
    const plain = l.replace(/\x1b\[[0-9;]*m/g, '');
    lines.push(plain ? `# ${plain}` : '#');
  }
  return lines.join('\n') + '\n';
}

export function cleanMessage(msg: string): string {
  return msg
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '');
}
