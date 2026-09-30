import { c, stripAnsi } from '../engine/ansi';
import type { EditorFn, GitContext } from '../engine/context';
import { aheadBehind } from '../engine/format';
import { runGit, COMMANDS as GIT_COMMANDS } from '../engine/git';
import { shortHash } from '../engine/objects';
import type { Repository } from '../engine/repo';
import { gitDate, globMatch } from '../engine/util';
import type { World } from '../engine/world';
import { VirtualFS, type Cwd, type Location } from './fs';
import { runGh, GH_COMPLETIONS } from './gh';
import { parseCommandLine, ShellSyntaxError, type SimpleCommand } from './tokenize';

export interface RunResult {
  lines: string[];
  code: number;
  clear?: boolean;
}

export interface ShellHooks {
  /** Game commands (hint, task, ...). Return null to fall through. */
  gameCommand?(name: string, args: string[]): Promise<string[] | null> | string[] | null;
  /** Extra names for tab completion. */
  gameCommandNames?: string[];
}

interface ExecResult {
  lines: string[];
  code: number;
  clear?: boolean;
}

type Builtin = (sh: Shell, args: string[], stdin: string | null) => Promise<ExecResult> | ExecResult;

const ok = (lines: string[] = []): ExecResult => ({ lines, code: 0 });
const err = (lines: string[] | string, code = 1): ExecResult => ({ lines: Array.isArray(lines) ? lines : [lines], code });

const EDITORS = ['nano', 'pico', 'vi', 'vim', 'nvim', 'emacs', 'code', 'subl', 'micro', 'ed', 'gedit', 'notepad'];

function splitFlags(args: string[]): { flags: Set<string>; rest: string[] } {
  const flags = new Set<string>();
  const rest: string[] = [];
  let noMore = false;
  for (const a of args) {
    if (!noMore && a === '--') {
      noMore = true;
      continue;
    }
    if (!noMore && /^-[a-zA-Z]+$/.test(a)) for (const ch of a.slice(1)) flags.add(ch);
    else if (!noMore && a.startsWith('--')) flags.add(a);
    else rest.push(a);
  }
  return { flags, rest };
}

function textLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export class Shell {
  cwd: Cwd = { dir: null, sub: '' };
  prevCwd: Cwd | null = null;
  history: string[] = [];
  fs: VirtualFS;

  constructor(
    public world: World,
    public editor: EditorFn,
    public hooks: ShellHooks = {},
  ) {
    this.fs = new VirtualFS(world);
  }

  /** The project directory the shell is currently in (initialized or not). */
  get dir(): Repository | null {
    if (!this.cwd.dir) return null;
    const d = this.world.dirs.get(this.cwd.dir);
    if (!d) {
      this.cwd = { dir: null, sub: '' };
      return null;
    }
    return d;
  }

  /** The git repo the shell is in, if any. */
  get repo(): Repository | null {
    const d = this.dir;
    return d?.initialized ? d : null;
  }

  cd(dir: string | null, sub = ''): void {
    this.prevCwd = { ...this.cwd };
    this.cwd = { dir, sub };
  }

  gitContext(): GitContext {
    return { world: this.world, dir: this.dir, cwd: this.cwd.sub, editor: this.editor, out: [] };
  }

  locate(p: string): Location {
    return this.fs.locate(this.cwd, p);
  }

  /* ------------------------------------------------------------------ */
  /* Prompt                                                               */
  /* ------------------------------------------------------------------ */

  gitPromptInfo(): string {
    const repo = this.repo;
    if (!repo) return '';
    const op = repo.op;
    let label: string;
    const branch = repo.currentBranch();
    const head = repo.headHash();
    if (op?.kind === 'rebase') {
      label = `${op.headName ?? shortHash(head ?? '')}|REBASE ${Math.min(op.done.length + (op.current ? 1 : 0), op.total)}/${op.total}`;
    } else if (branch) {
      label = branch;
    } else {
      label = `detached@${shortHash(head ?? '')}`;
    }
    if (op?.kind === 'merge' && !op.squash) label += '|MERGING';
    if (op?.kind === 'cherry-pick') label += '|CHERRY-PICKING';
    if (op?.kind === 'revert') label += '|REVERTING';
    if (repo.bisect) label += '|BISECTING';

    const s = repo.status();
    let flags = '';
    if (s.unstaged.length || s.unmerged.length) flags += '*';
    if (s.staged.length) flags += '+';
    if (s.untracked.length) flags += '%';
    if (repo.stash.length) flags += '$';
    let up = '';
    if (branch) {
      const ab = aheadBehind(repo, branch);
      if (ab?.gone) up = ' ⨯';
      else if (ab) {
        if (ab.ahead) up += ` ↑${ab.ahead}`;
        if (ab.behind) up += ` ↓${ab.behind}`;
      }
    }
    const dirty = flags.length > 0;
    const labelColored = op || repo.bisect ? c.boldMagenta(label) : dirty ? c.boldYellow(label) : c.boldGreen(label);
    return ` ${c.cyan('(')}${labelColored}${flags ? ' ' + c.red(flags) : ''}${up ? c.cyan(up) : ''}${c.cyan(')')}`;
  }

  prompt(): string {
    return `${c.boldGreen(`${this.world.user}@${this.world.host.toLowerCase()}`)}:${c.boldBlue(this.fs.displayPath(this.cwd))}${this.gitPromptInfo()}$ `;
  }

  /* ------------------------------------------------------------------ */
  /* Running commands                                                     */
  /* ------------------------------------------------------------------ */

  async run(line: string): Promise<RunResult> {
    const trimmed = line.trim();
    if (!trimmed) return { lines: [], code: 0 };
    this.history.push(trimmed);
    this.world.emit({ type: 'command', line: trimmed });

    let pipelines;
    try {
      pipelines = parseCommandLine(trimmed);
    } catch (e) {
      if (e instanceof ShellSyntaxError) return { lines: [e.message], code: 1 };
      throw e;
    }

    const out: string[] = [];
    let last = 0;
    let clear = false;
    for (const pl of pipelines) {
      if (pl.op === '&&' && last !== 0) continue;
      if (pl.op === '||' && last === 0) continue;
      let stdin: string | null = null;
      for (let i = 0; i < pl.commands.length; i++) {
        const cmd = pl.commands[i];
        const isLast = i === pl.commands.length - 1;
        const res = await this.exec(cmd, stdin);
        if (res.clear) {
          clear = true;
          out.length = 0;
        }
        last = res.code;
        let lines = res.lines;
        if (cmd.redirect) {
          const loc = this.locate(this.expandTilde(cmd.redirect.target));
          const text = lines.map(stripAnsi).join('\n') + (lines.length ? '\n' : '');
          const problem = this.writeCheck(loc, cmd.redirect.target);
          if (problem) {
            out.push(problem);
            last = 1;
            break;
          }
          const prev = cmd.redirect.append ? this.fs.read(loc) ?? '' : '';
          this.fs.write(loc, prev + text);
          lines = [];
        }
        if (!isLast) stdin = lines.map(stripAnsi).join('\n') + (lines.length ? '\n' : '');
        else out.push(...lines);
      }
    }
    return { lines: out, code: last, clear };
  }

  private writeCheck(loc: Location, raw: string): string | null {
    if (loc.outside) return `zsh: permission denied: ${raw}`;
    if (this.fs.isGitPath(loc)) return `zsh: permission denied: ${raw} (hands off .git)`;
    if (this.fs.isDir(loc)) return `zsh: is a directory: ${raw}`;
    if (!loc.dir && loc.path.includes('/')) return `zsh: no such file or directory: ${raw}`;
    return null;
  }

  expandTilde(w: string): string {
    if (w === '~' || w.startsWith('~/')) return this.fs.home + w.slice(1);
    return w;
  }

  private expandWords(cmd: SimpleCommand): string[] | string {
    const out: string[] = [];
    for (const w of cmd.words) {
      let text = w.text
        .replace(/\$HOME\b|\$\{HOME\}/g, this.fs.home)
        .replace(/\$USER\b/g, this.world.user)
        .replace(/\$PWD\b/g, this.fs.absPath(this.cwd));
      text = this.expandTilde(text);
      if (w.glob && out.length > 0) {
        const matches = this.globExpand(text);
        if (matches === null) return `zsh: no matches found: ${text}`;
        out.push(...matches);
      } else out.push(text);
    }
    return out;
  }

  /** Expand a glob against the virtual filesystem (last path segment only). */
  private globExpand(pattern: string): string[] | null {
    const slash = pattern.lastIndexOf('/');
    const dirPart = slash >= 0 ? pattern.slice(0, slash) : '';
    const filePart = slash >= 0 ? pattern.slice(slash + 1) : pattern;
    if (/[*?]/.test(dirPart)) return null;
    const loc = this.locate(dirPart || '.');
    if (!this.fs.isDir(loc)) return null;
    const names = this.fs
      .list(loc, filePart.startsWith('.'))
      .map((e) => e.name)
      .filter((n) => globMatch(filePart, n));
    if (!names.length) return null;
    return names.map((n) => (dirPart ? `${dirPart}/${n}` : n));
  }

  private async exec(cmd: SimpleCommand, stdin: string | null): Promise<ExecResult> {
    const words = this.expandWords(cmd);
    if (typeof words === 'string') return err(words);
    const [name, ...args] = words;

    const game = await this.hooks.gameCommand?.(name, args);
    if (game) return ok(game);

    if (name === 'git') {
      const ctx = this.gitContext();
      const code = await runGit(ctx, args);
      // git init/clone may have created directories; keep cwd valid.
      void this.dir;
      return { lines: ctx.out, code };
    }
    if (name === 'gh') {
      const ctx = this.gitContext();
      const code = await runGh(ctx, args, this);
      return { lines: ctx.out, code };
    }
    const b = BUILTINS[name];
    if (b) return b(this, args, stdin);
    if (EDITORS.includes(name)) return openEditor(this, name, args);
    if (name.startsWith('./') || name.startsWith('/')) {
      if (/test/.test(name)) return runTests(this);
      return err(`zsh: permission denied: ${name}`, 126);
    }
    this.world.emit({ type: 'unknown-command', name });
    return err(`zsh: command not found: ${name}`, 127);
  }

  /* ------------------------------------------------------------------ */
  /* Tab completion                                                       */
  /* ------------------------------------------------------------------ */

  complete(line: string): { line: string; options: string[] } {
    const endsWithSpace = /\s$/.test(line);
    const parts = line.split(/\s+/).filter(Boolean);
    const partial = endsWithSpace ? '' : parts.pop() ?? '';
    const before = parts;
    let candidates: string[] = [];
    let pathMode = false;

    const refNames = () => {
      const repo = this.repo;
      if (!repo) return [];
      return ['HEAD', ...repo.branches(), ...repo.remoteBranches(), ...repo.tags()];
    };

    if (!before.length) {
      candidates = [
        ...Object.keys(BUILTINS),
        'git',
        'gh',
        'nano',
        ...(this.hooks.gameCommandNames ?? []),
      ];
    } else if (before[0] === 'git') {
      const sub = before[1];
      if (before.length === 1) {
        const aliases = [...this.world.globalConfig.keys()].filter((k) => k.startsWith('alias.')).map((k) => k.slice(6));
        candidates = [...Object.keys(GIT_COMMANDS), 'help', ...aliases];
      } else if (['checkout', 'switch', 'merge', 'rebase', 'cherry-pick', 'log', 'show', 'reset', 'revert', 'branch', 'diff', 'tag', 'blame'].includes(sub)) {
        candidates = refNames();
        if (['checkout', 'diff', 'reset', 'blame', 'log'].includes(sub)) pathMode = true;
      } else if (['push', 'pull', 'fetch'].includes(sub)) {
        const repo = this.repo;
        candidates = before.length === 2 ? repo?.remotes() ?? [] : repo?.branches() ?? [];
      } else if (sub === 'remote') {
        candidates = before.length === 2 ? ['add', 'remove', 'rename', 'show', 'get-url', 'set-url', '-v'] : this.repo?.remotes() ?? [];
      } else if (sub === 'stash') {
        candidates = before.length === 2 ? ['push', 'pop', 'apply', 'list', 'show', 'drop', 'clear', 'branch'] : (this.repo?.stash ?? []).map((_, i) => `stash@{${i}}`);
      } else if (sub === 'bisect') {
        candidates = ['start', 'good', 'bad', 'skip', 'reset', 'log', 'run'];
      } else if (sub === 'help') {
        candidates = Object.keys(GIT_COMMANDS);
      } else {
        pathMode = true;
      }
    } else if (before[0] === 'gh') {
      candidates = GH_COMPLETIONS(before.slice(1));
    } else {
      pathMode = true;
    }

    if (pathMode) {
      const slash = partial.lastIndexOf('/');
      const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : '';
      const loc = this.locate(this.expandTilde(dirPart || '.'));
      if (this.fs.isDir(loc)) {
        for (const e of this.fs.list(loc, partial.slice(slash + 1).startsWith('.'))) {
          candidates.push(dirPart + e.name + (e.dir ? '/' : ''));
        }
      }
    }

    const matches = [...new Set(candidates)].filter((cand) => cand.startsWith(partial)).sort();
    if (!matches.length) return { line, options: [] };
    let common = matches[0];
    for (const m of matches) {
      while (!m.startsWith(common)) common = common.slice(0, -1);
    }
    const prefix = line.slice(0, line.length - partial.length);
    if (matches.length === 1) {
      const m = matches[0];
      return { line: prefix + m + (m.endsWith('/') ? '' : ' '), options: [] };
    }
    return { line: prefix + common, options: common === partial ? matches : [] };
  }
}

/* ======================================================================== */
/* Builtins                                                                  */
/* ======================================================================== */

async function openEditor(sh: Shell, name: string, args: string[]): Promise<ExecResult> {
  const pre: string[] = [];
  if (['vi', 'vim', 'nvim'].includes(name)) {
    pre.push(c.yellow('[IT Notice] vim was uninstalled after The Incident of 2019 (an intern, 3 days, no exit).'), c.yellow('Opening nano instead.'));
    sh.world.emit({ type: 'vim-attempt' });
  } else if (name === 'emacs') {
    pre.push(c.yellow('emacs: installing would exceed your 2 GB disk quota. Opening nano instead.'));
  } else if (name === 'code' || name === 'subl' || name === 'gedit' || name === 'notepad') {
    pre.push(c.yellow(`${name}: GUI apps are blocked on this terminal session. Opening nano instead.`));
  } else if (name === 'ed') {
    pre.push('?');
    return err(pre);
  }
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) return err([...pre, `${name}: a file name is required on this machine (e.g. nano README.md)`]);
  const loc = sh.locate(file);
  if (loc.outside) return err([...pre, `${name}: ${file}: Permission denied`]);
  if (sh.fs.isGitPath(loc)) return err([...pre, `${name}: ${file}: editing git's internals by hand is how Gary got fired`]);
  if (sh.fs.isDir(loc)) return err([...pre, `${name}: ${file}: Is a directory`]);
  if (!loc.dir && loc.path.includes('/')) return err([...pre, `${name}: ${file}: No such file or directory`]);
  const current = sh.fs.read(loc) ?? '';
  const result = await sh.editor(file, current);
  if (result !== null && result !== current) {
    sh.fs.write(loc, result);
    sh.world.emit({ type: 'edit', path: loc.path, dir: loc.dirName });
  }
  return ok(pre);
}

function runTests(sh: Shell): ExecResult {
  const repo = sh.repo;
  if (!repo || !sh.world.testRunner) {
    return err(['npm ERR! Missing script: "test"', '', 'npm ERR! To see a list of scripts, run:', 'npm ERR!   npm run']);
  }
  const r = sh.world.testRunner(repo);
  sh.world.emit({ type: 'test-run', pass: r.pass, head: repo.headHash() });
  return { lines: r.output.split('\n'), code: r.pass ? 0 : 1 };
}

const FORTUNES = [
  'A clean working tree is a sign of a disturbed mind.',
  '"It works on my machine." - Everyone, at some point, on this machine.',
  'You will soon be asked to "just quickly" rebase something.',
  'The reflog remembers what you would rather forget.',
  'There are two hard problems in computer science: cache invalidation, naming things, and off-by-one errors.',
  "Commit early, commit often, push when it's actually done.",
  'Today is a good day to write a descriptive commit message. Tomorrow will be "fix".',
  'A force push in time saves nine... coworkers from ever trusting you again.',
];

const EXIT_JOKES = [
  'logout: nice try. Your shift ends at 5:30 PM.',
  'exit: Badge-out requires all tickets to be closed.',
  'Connection to happiness closed by remote host.',
];

const BUILTINS: Record<string, Builtin> = {
  help: () =>
    ok([
      c.bold('Available commands'),
      `  ${c.cyan('git')} <command>        the whole point (try ${c.cyan('git help')})`,
      `  ${c.cyan('gh')} pr|issue ...      GitHub CLI: pull requests & issues`,
      `  ${c.cyan('ls cat cd pwd tree')}  look around`,
      `  ${c.cyan('echo "x" > file')}     write a file (>> appends)`,
      `  ${c.cyan('nano')} <file>          edit a file (Ctrl+O save, Ctrl+X exit)`,
      `  ${c.cyan('touch rm mv cp mkdir')} manage files`,
      `  ${c.cyan('grep head tail wc')}   search & inspect`,
      `  ${c.cyan('npm test')}             run the test suite (where there is one)`,
      `  ${c.cyan('clear')}                clear the screen (or Ctrl+L)`,
    ]),
  clear: () => ({ lines: [], code: 0, clear: true }),
  pwd: (sh) => ok([sh.fs.absPath(sh.cwd)]),
  whoami: (sh) => ok([sh.world.user]),
  hostname: (sh) => ok([sh.world.host]),
  uname: (sh, args) =>
    ok([args.includes('-a') ? `Linux ${sh.world.host} 5.4.0-conglomo-lts #1 SMP x86_64 GNU/Linux (EOL, do not upgrade)` : 'Linux']),
  date: (sh) => ok([gitDate(sh.world.clock.now()).replace('-0500', 'EST')]),
  history: (sh) => ok(sh.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`)),
  echo: (_sh, args) => {
    const { flags, rest } = splitFlags(args.filter((a) => a === '-n' || a === '-e' || !a.startsWith('-') || a.length === 1));
    let text = rest.join(' ');
    if (flags.has('e')) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    const lines = text.split('\n');
    return ok(flags.has('n') && text === '' ? [] : lines);
  },
  cd: (sh, args) => {
    let target = args[0] ?? '~';
    if (target === '-') {
      if (!sh.prevCwd) return err('cd: OLDPWD not set');
      const prev = sh.prevCwd;
      sh.cd(prev.dir, prev.sub);
      return ok([sh.fs.absPath(sh.cwd)]);
    }
    target = sh.expandTilde(target);
    const loc = sh.locate(target);
    if (loc.outside) return err(`cd: permission denied: ${args[0]}`);
    if (!loc.dir && loc.path) {
      return err(sh.world.homeFiles.has(loc.path) ? `cd: not a directory: ${args[0]}` : `cd: no such file or directory: ${args[0]}`);
    }
    if (loc.dir && sh.fs.isGitPath(loc)) return err(`cd: permission denied: ${args[0]} (there's nothing for you in there)`);
    if (loc.dir && !sh.fs.isDir(loc)) {
      return err(sh.fs.isFile(loc) ? `cd: not a directory: ${args[0]}` : `cd: no such file or directory: ${args[0]}`);
    }
    sh.cd(loc.dirName, loc.path);
    sh.world.emit({ type: 'cd', dir: loc.dirName, sub: loc.path });
    return ok();
  },
  ls: (sh, args) => {
    const { flags, rest } = splitFlags(args);
    const all = flags.has('a') || flags.has('A');
    const long = flags.has('l');
    const one = flags.has('1') || long;
    const targets = rest.length ? rest : ['.'];
    const out: string[] = [];
    let code = 0;
    for (const t of targets) {
      const loc = sh.locate(t);
      if (sh.fs.isGitPath(loc) && loc.path === '.git') {
        if (targets.length > 1) out.push(`${t}:`);
        out.push(c.boldBlue('HEAD') + '  ' + ['config', 'description', 'hooks', 'index', 'info', 'logs', 'objects', 'refs'].map((n) => (/[a-z]s$|hooks|info/.test(n) ? c.boldBlue(n) : n)).join('  '));
        continue;
      }
      if (sh.fs.isFile(loc)) {
        out.push(t);
        continue;
      }
      if (!sh.fs.isDir(loc)) {
        out.push(`ls: cannot access '${t}': No such file or directory`);
        code = 2;
        continue;
      }
      const entries = sh.fs.list(loc, all);
      if (targets.length > 1) out.push(`${t}:`);
      const fmt = (e: { name: string; dir: boolean }) => (e.dir ? c.boldBlue(e.name) : e.name);
      if (long) {
        out.push(`total ${entries.length * 4}`);
        for (const e of entries) {
          const size = e.dir ? 4096 : (sh.fs.read(sh.locate(`${t}/${e.name}`)) ?? '').length;
          out.push(`${e.dir ? 'drwxr-xr-x' : '-rw-r--r--'}  1 ${sh.world.user} staff ${String(size).padStart(6)} Mar  2 09:00 ${fmt(e)}`);
        }
      } else if (one) out.push(...entries.map(fmt));
      else if (entries.length) out.push(entries.map(fmt).join('  '));
    }
    return { lines: out, code };
  },
  tree: (sh, args) => {
    const target = args.find((a) => !a.startsWith('-')) ?? '.';
    const all = args.includes('-a');
    const loc = sh.locate(target);
    if (!sh.fs.isDir(loc)) return err(`${target} [error opening dir]`);
    const out = [c.boldBlue(target)];
    let dirs = 0;
    let files = 0;
    const walk = (l: Location, prefix: string) => {
      const entries = sh.fs.list(l, all).filter((e) => e.name !== '.git');
      entries.forEach((e, i) => {
        const lastEntry = i === entries.length - 1;
        out.push(`${prefix}${lastEntry ? '└── ' : '├── '}${e.dir ? c.boldBlue(e.name) : e.name}`);
        if (e.dir) {
          dirs++;
          walk({ ...l, path: l.path ? `${l.path}/${e.name}` : e.name, dir: l.dir ?? sh.world.dirs.get(e.name) ?? null, dirName: l.dirName ?? e.name }, prefix + (lastEntry ? '    ' : '│   '));
        } else files++;
      });
    };
    if (!loc.dir && loc.path === '') {
      // Home: projects are directories; walk each one.
      const entries = sh.fs.list(loc, all);
      entries.forEach((e, i) => {
        const lastEntry = i === entries.length - 1;
        out.push(`${lastEntry ? '└── ' : '├── '}${e.dir ? c.boldBlue(e.name) : e.name}`);
        if (e.dir) {
          dirs++;
          walk(sh.locate(`~/${e.name}`), lastEntry ? '    ' : '│   ');
        } else files++;
      });
    } else walk(loc, '');
    out.push('', `${dirs} director${dirs === 1 ? 'y' : 'ies'}, ${files} file${files === 1 ? '' : 's'}`);
    return ok(out);
  },
  cat: (sh, args, stdin) => {
    const { flags, rest } = splitFlags(args);
    if (!rest.length) return ok(stdin ? textLines(stdin) : []);
    const out: string[] = [];
    let code = 0;
    for (const f of rest) {
      const loc = sh.locate(f);
      if (sh.fs.isGitPath(loc)) {
        if (loc.path === '.git/HEAD' && loc.dir) {
          const h = loc.dir.head;
          out.push(h.kind === 'branch' ? `ref: refs/heads/${h.name}` : h.hash);
          continue;
        }
        out.push(`cat: ${f}: Permission denied (use git commands to look inside .git)`);
        code = 1;
        continue;
      }
      if (sh.fs.isDir(loc)) {
        out.push(`cat: ${f}: Is a directory`);
        code = 1;
        continue;
      }
      const content = sh.fs.read(loc);
      if (content === undefined) {
        out.push(`cat: ${f}: No such file or directory`);
        code = 1;
        continue;
      }
      const lines = textLines(content);
      out.push(...(flags.has('n') ? lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`) : lines));
    }
    return { lines: out, code };
  },
  head: (sh, args, stdin) => headTail(sh, args, stdin, 'head'),
  tail: (sh, args, stdin) => headTail(sh, args, stdin, 'tail'),
  wc: (sh, args, stdin) => {
    const { flags, rest } = splitFlags(args);
    const count = (s: string) => {
      const l = (s.match(/\n/g) ?? []).length;
      const w = s.split(/\s+/).filter(Boolean).length;
      if (flags.has('l')) return `${l}`;
      if (flags.has('w')) return `${w}`;
      if (flags.has('c')) return `${s.length}`;
      return `${String(l).padStart(7)} ${String(w).padStart(7)} ${String(s.length).padStart(7)}`;
    };
    if (!rest.length) return ok([count(stdin ?? '')]);
    return ok(rest.map((f) => `${count(sh.fs.read(sh.locate(f)) ?? '')} ${f}`));
  },
  sort: (sh, args, stdin) => {
    const { flags, rest } = splitFlags(args);
    const text = rest.length ? rest.map((f) => sh.fs.read(sh.locate(f)) ?? '').join('') : stdin ?? '';
    const lines = textLines(text).sort();
    if (flags.has('r')) lines.reverse();
    return ok(lines);
  },
  uniq: (_sh, _args, stdin) => ok(textLines(stdin ?? '').filter((l, i, arr) => i === 0 || arr[i - 1] !== l)),
  grep: (sh, args, stdin) => {
    const { flags, rest } = splitFlags(args);
    const [pattern, ...files] = rest;
    if (pattern === undefined) return err('usage: grep [-inrvcl] pattern [file ...]', 2);
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags.has('i') ? 'i' : '');
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags.has('i') ? 'i' : '');
    }
    const invert = flags.has('v');
    const sources: Array<{ name: string | null; text: string }> = [];
    if (flags.has('r') || flags.has('R')) {
      for (const f of files.length ? files : ['.']) {
        const loc = sh.locate(f);
        if (sh.fs.isFile(loc)) sources.push({ name: f, text: sh.fs.read(loc)! });
        else
          for (const p of sh.fs.walkFiles(loc)) {
            const rel = loc.path ? p.slice(loc.path.length + 1) : p;
            const shown = f === '.' ? rel : `${f.replace(/\/$/, '')}/${rel}`;
            sources.push({ name: shown, text: loc.dir ? loc.dir.worktree.get(p)! : sh.world.homeFiles.get(p)! });
          }
      }
    } else if (files.length) {
      for (const f of files) {
        const loc = sh.locate(f);
        const t = sh.fs.read(loc);
        if (t === undefined) return err(`grep: ${f}: ${sh.fs.isDir(loc) ? 'Is a directory' : 'No such file or directory'}`, 2);
        sources.push({ name: f, text: t });
      }
    } else sources.push({ name: null, text: stdin ?? '' });
    const multi = sources.length > 1 || flags.has('r');
    const out: string[] = [];
    let found = false;
    for (const s of sources) {
      let n = 0;
      textLines(s.text).forEach((line, i) => {
        if (re.test(line) === invert) return;
        found = true;
        n++;
        if (flags.has('c') || flags.has('l')) return;
        const hl = invert ? line : line.replace(new RegExp(re.source, re.flags + 'g'), (m) => c.boldRed(m));
        const prefix = `${multi && s.name ? c.magenta(s.name) + c.cyan(':') : ''}${flags.has('n') ? c.green(String(i + 1)) + c.cyan(':') : ''}`;
        out.push(prefix + hl);
      });
      if (flags.has('c')) out.push(`${multi && s.name ? s.name + ':' : ''}${n}`);
      if (flags.has('l') && n) out.push(s.name ?? '(standard input)');
    }
    return { lines: out, code: found ? 0 : 1 };
  },
  touch: (sh, args) => {
    for (const f of args.filter((a) => !a.startsWith('-'))) {
      const loc = sh.locate(f);
      const problem = writeProblem(sh, loc, f, 'touch');
      if (problem) return err(problem);
      if (!sh.fs.exists(loc)) sh.fs.write(loc, '');
    }
    return ok();
  },
  mkdir: (sh, args) => {
    const { flags, rest } = splitFlags(args);
    for (const d of rest) {
      const loc = sh.locate(d);
      if (loc.outside) return err(`mkdir: cannot create directory '${d}': Permission denied`);
      if (sh.fs.exists(loc)) {
        if (flags.has('p')) continue;
        return err(`mkdir: cannot create directory '${d}': File exists`);
      }
      if (!loc.dir) {
        if (loc.path.includes('/')) {
          const top = loc.path.split('/')[0];
          if (!flags.has('p') && !sh.world.dirs.has(top)) return err(`mkdir: cannot create directory '${d}': No such file or directory`);
          const proj = sh.world.dirs.get(top) ?? sh.world.createDir(top, false);
          proj.emptyDirs.add(loc.path.split('/').slice(1).join('/'));
        } else sh.world.createDir(loc.path, false);
      } else {
        const parent = loc.path.split('/').slice(0, -1).join('/');
        if (parent && !sh.fs.isDir({ ...loc, path: parent }) && !flags.has('p')) {
          return err(`mkdir: cannot create directory '${d}': No such file or directory`);
        }
        loc.dir.emptyDirs.add(loc.path);
      }
    }
    return ok();
  },
  rm: (sh, args) => {
    const { flags, rest } = splitFlags(args);
    const recursive = flags.has('r') || flags.has('R') || flags.has('--recursive');
    const force = flags.has('f') || flags.has('--force');
    if (!rest.length) return err('rm: missing operand');
    const out: string[] = [];
    let code = 0;
    for (const p of rest) {
      const loc = sh.locate(p);
      if (loc.outside || (p === '/' || p === '/*')) {
        out.push(`rm: it is dangerous to operate recursively on '/'`, 'rm: use --no-preserve-root to override this failsafe');
        sh.world.emit({ type: 'rm-root' });
        code = 1;
        continue;
      }
      if (!loc.dir && loc.path === '') {
        out.push(`rm: refusing to remove '${p}': IT has seen this movie before`);
        sh.world.emit({ type: 'rm-root' });
        code = 1;
        continue;
      }
      if (sh.fs.isGitPath(loc)) {
        if (!recursive) {
          out.push(`rm: cannot remove '${p}': Is a directory`);
          code = 1;
          continue;
        }
        // The nuclear option: the repository's entire history, gone.
        const repo = loc.dir!;
        const hadRepo = repo.initialized;
        repo.initialized = false;
        repo.refs.clear();
        repo.index.clear();
        repo.conflicts.clear();
        repo.reflogs.clear();
        repo.stash = [];
        repo.op = null;
        repo.config.clear();
        if (hadRepo) sh.world.emit({ type: 'rm-git', dir: repo.name });
        continue;
      }
      if (!loc.dir && sh.world.dirs.has(loc.path)) {
        if (!recursive) {
          out.push(`rm: cannot remove '${p}': Is a directory`);
          code = 1;
          continue;
        }
        sh.world.dirs.delete(loc.path);
        sh.world.emit({ type: 'rm-project', dir: loc.path });
        continue;
      }
      if (sh.fs.isDir(loc)) {
        if (!recursive) {
          out.push(`rm: cannot remove '${p}': Is a directory`);
          code = 1;
          continue;
        }
        const prefix = loc.path ? loc.path + '/' : '';
        const repo = loc.dir!;
        for (const k of [...repo.worktree.keys()]) if (!prefix || k.startsWith(prefix)) repo.worktree.delete(k);
        for (const d of [...repo.emptyDirs]) if (!prefix || d === loc.path || d.startsWith(prefix)) repo.emptyDirs.delete(d);
        sh.world.emit({ type: 'rm', paths: [loc.path], dir: repo.name });
        continue;
      }
      if (!sh.fs.isFile(loc)) {
        if (!force) {
          out.push(`rm: cannot remove '${p}': No such file or directory`);
          code = 1;
        }
        continue;
      }
      sh.fs.remove(loc);
      sh.world.emit({ type: 'rm', paths: [loc.path], dir: loc.dirName });
    }
    return { lines: out, code };
  },
  mv: (sh, args) => copyMove(sh, args, true),
  cp: (sh, args) => copyMove(sh, args, false),
  sudo: (sh, args) => {
    sh.world.emit({ type: 'sudo', args });
    return err([`[sudo] password for ${sh.world.user}: `, `${sh.world.user} is not in the sudoers file.  This incident will be reported.`]);
  },
  su: (sh) => {
    sh.world.emit({ type: 'sudo', args: ['su'] });
    return err('su: Authentication failure (and a ticket has been filed with IT)');
  },
  exit: () => err(EXIT_JOKES[Math.floor(Math.random() * EXIT_JOKES.length)]),
  logout: () => err(EXIT_JOKES[0]),
  man: (_sh, args) =>
    err(
      args[0] === 'git' || args[0]?.startsWith('git-')
        ? `No manual entry for ${args[0]}. Try ${c.cyan('git help')} or ${c.cyan('git help <command>')} - they're friendlier anyway.`
        : `No manual entry for ${args[0] ?? '(nothing)'}`,
    ),
  npm: (sh, args) => {
    const sub = args[0];
    if (sub === 'test' || sub === 't' || (sub === 'run' && args[1] === 'test')) return runTests(sh);
    if (sub === 'install' || sub === 'i' || sub === 'ci') {
      return ok(['', 'added 1,482 packages, and audited 1,483 packages in 3m', '', '219 packages are looking for funding', '  run `npm fund` for details', '', c.red('312 vulnerabilities (12 low, 200 moderate, 99 high, 1 critical)'), '', 'To address all issues (including breaking changes), run:', '  npm audit fix --force', '', c.gray('(Please do not run that.)')]);
    }
    if (sub === 'start' || (sub === 'run' && args[1] === 'dev')) return err('Error: listen EADDRINUSE: address already in use :::3000 (Greg has been running it since 2022)');
    return err(`npm ERR! Unknown command: "${sub ?? ''}"`);
  },
  yarn: (sh, args) => (args[0] === 'test' ? runTests(sh) : err('yarn: Corporate standardized on npm in 2021. And pnpm in 2022. And npm again in 2023.')),
  pnpm: (sh, args) => (args[0] === 'test' ? runTests(sh) : err('pnpm: see yarn')),
  make: (sh, args) => (args[0] === 'test' ? runTests(sh) : err("make: *** No rule to make target. Stop.")),
  pytest: (sh) => runTests(sh),
  ssh: () => err('ssh: connect to host: Blocked by Conglomo Corp. Network Policy (Category: "Fun")'),
  curl: () => err('curl: (7) Failed to connect: Blocked by Conglomo Corp. Web Filter (Category: "Productivity")'),
  wget: () => err('wget: unable to resolve host address. The internet has been deemed out of scope.'),
  ping: () => err('ping: ICMP is disabled. Please ping people on Pingr instead.'),
  python: () => err('Interpreters require a JIRA ticket (IT-4471) and three levels of approval.'),
  python3: () => err('Interpreters require a JIRA ticket (IT-4471) and three levels of approval.'),
  node: () => err('Interpreters require a JIRA ticket (IT-4471) and three levels of approval.'),
  fortune: () => ok([FORTUNES[Math.floor(Math.random() * FORTUNES.length)]]),
  cowsay: (_sh, args) => {
    const text = args.join(' ') || 'Moo. Commit your changes.';
    const bar = '-'.repeat(text.length + 2);
    return ok([` ${'_'.repeat(text.length + 2)}`, `< ${text} >`, ` ${bar}`, '        \\   ^__^', '         \\  (oo)\\_______', '            (__)\\       )\\/\\', '                ||----w |', '                ||     ||']);
  },
  sl: () => ok(['      ====        ________                ___________', '  _D _|  |_______/        \\__I_I_____===__|_________|', '   |(_)---  |   H\\________/ |   |        =|___ ___|', '   /     |  |   H  |  |     |   |         ||_| |_||', '  |      |  |   H  |__--------------------| [___] |', '  | ________|___H__/__|_____/[][]~\\_______|       |', '  |/ |   |-----------I_____I [][] []  D   |=======|__', c.gray('(You meant `ls`. The train is a warning.)')]),
  kill: () => err('kill: Operation not permitted'),
  killall: () => err('killall: Operation not permitted'),
  shutdown: () => err('shutdown: Only IT may shut this machine down. It has been running since 2017.'),
  reboot: () => err('reboot: see shutdown'),
  env: (sh) => ok([`HOME=${sh.fs.home}`, `USER=${sh.world.user}`, 'SHELL=/bin/zsh', 'EDITOR=nano', 'GIT_EDITOR=nano', 'LANG=en_US.UTF-8', 'MOTIVATION=low']),
  export: () => ok(),
  alias: () => err('alias: use `git config --global alias.<name> <command>` for git aliases'),
  which: (_sh, args) => ok(args.map((a) => (a === 'git' ? '/usr/bin/git' : a === 'gh' ? '/usr/local/bin/gh' : `${a} not found`))),
  true: () => ok(),
  false: () => err([]),
};

function writeProblem(sh: Shell, loc: Location, raw: string, cmd: string): string | null {
  if (loc.outside) return `${cmd}: cannot touch '${raw}': Permission denied`;
  if (sh.fs.isGitPath(loc)) return `${cmd}: cannot touch '${raw}': Permission denied (hands off .git)`;
  if (!loc.dir && loc.path.includes('/')) return `${cmd}: cannot touch '${raw}': No such file or directory`;
  if (loc.dir && loc.path.includes('/')) {
    const parent = loc.path.split('/').slice(0, -1).join('/');
    if (!sh.fs.isDir({ ...loc, path: parent })) return `${cmd}: cannot touch '${raw}': No such file or directory`;
  }
  return null;
}

function headTail(sh: Shell, args: string[], stdin: string | null, which: 'head' | 'tail'): ExecResult {
  let n = 10;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n') n = parseInt(args[++i] ?? '10', 10);
    else if (/^-\d+$/.test(a)) n = parseInt(a.slice(1), 10);
    else if (/^-n\d+$/.test(a)) n = parseInt(a.slice(2), 10);
    else files.push(a);
  }
  const text = files.length ? files.map((f) => sh.fs.read(sh.locate(f)) ?? '').join('') : stdin ?? '';
  const lines = textLines(text);
  return ok(which === 'head' ? lines.slice(0, n) : lines.slice(Math.max(0, lines.length - n)));
}

function copyMove(sh: Shell, args: string[], move: boolean): ExecResult {
  const name = move ? 'mv' : 'cp';
  const { flags, rest } = splitFlags(args);
  if (rest.length < 2) return err(`${name}: missing destination file operand`);
  const dst = rest[rest.length - 1];
  const srcs = rest.slice(0, -1);
  const dstLoc = sh.locate(dst);
  if (dstLoc.outside || sh.fs.isGitPath(dstLoc)) return err(`${name}: cannot write '${dst}': Permission denied`);
  for (const s of srcs) {
    const srcLoc = sh.locate(s);
    if (sh.fs.isGitPath(srcLoc)) return err(`${name}: cannot touch '${s}': Permission denied`);
    if (sh.fs.isDir(srcLoc)) {
      if (!move && !flags.has('r')) return err(`cp: -r not specified; omitting directory '${s}'`);
      if (!srcLoc.dir || !srcLoc.path) return err(`${name}: moving whole projects around is above your pay grade`);
      const base = sh.fs.isDir(dstLoc) ? `${dstLoc.path ? dstLoc.path + '/' : ''}${srcLoc.path.split('/').pop()}` : dstLoc.path;
      if (!dstLoc.dir) return err(`${name}: cannot move files out of the project`);
      const prefix = srcLoc.path + '/';
      for (const k of [...srcLoc.dir.worktree.keys()]) {
        if (!k.startsWith(prefix)) continue;
        const content = srcLoc.dir.worktree.get(k)!;
        dstLoc.dir.worktree.set(`${base}/${k.slice(prefix.length)}`, content);
        if (move) srcLoc.dir.worktree.delete(k);
      }
      continue;
    }
    const content = sh.fs.read(srcLoc);
    if (content === undefined) return err(`${name}: cannot stat '${s}': No such file or directory`);
    let target = dstLoc;
    if (sh.fs.isDir(dstLoc)) {
      const fname = srcLoc.path.split('/').pop()!;
      target = dstLoc.dir ? { ...dstLoc, path: dstLoc.path ? `${dstLoc.path}/${fname}` : fname } : sh.locate(`${dst}/${fname}`);
      if (!dstLoc.dir && dstLoc.path === '') target = { dir: null, dirName: null, path: fname };
    }
    const problem = writeProblem(sh, target, dst, name);
    if (problem) return err(problem);
    sh.fs.write(target, content);
    if (move) sh.fs.remove(srcLoc);
  }
  sh.world.emit({ type: move ? 'mv' : 'cp', args: rest });
  return ok();
}
