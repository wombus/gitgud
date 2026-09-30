import { c } from './ansi';
import { cmdAdd, cmdClean, cmdCommit, cmdConfig, cmdInit, cmdMv, cmdRestore, cmdRm, cmdStatus } from './commands/basic';
import { cmdBisect } from './commands/bisect';
import { cmdBranch, cmdCheckout, cmdSwitch, cmdTag } from './commands/branching';
import { cmdBlame, cmdDiff, cmdLog, cmdReflog, cmdShortlog, cmdShow } from './commands/history';
import { cmdCherryPick, cmdMerge, cmdRebase, cmdRevert } from './commands/merging';
import { cmdClone, cmdFetch, cmdPull, cmdPush, cmdRemote } from './commands/remote';
import { cmdReset } from './commands/reset';
import { cmdStash } from './commands/stash';
import { print, type Command, type GitContext } from './context';
import { commandHelp, generalHelp } from './help';
import { GitError, levenshtein } from './util';

/** The `git` executable: global options, aliases, dispatch, and error handling. */

export const COMMANDS: Record<string, Command> = {
  init: cmdInit,
  clone: cmdClone,
  config: cmdConfig,
  status: cmdStatus,
  add: cmdAdd,
  rm: cmdRm,
  mv: cmdMv,
  commit: cmdCommit,
  restore: cmdRestore,
  clean: cmdClean,
  log: cmdLog,
  shortlog: cmdShortlog,
  show: cmdShow,
  diff: cmdDiff,
  reflog: cmdReflog,
  blame: cmdBlame,
  branch: cmdBranch,
  checkout: cmdCheckout,
  switch: cmdSwitch,
  tag: cmdTag,
  merge: cmdMerge,
  rebase: cmdRebase,
  'cherry-pick': cmdCherryPick,
  revert: cmdRevert,
  reset: cmdReset,
  stash: cmdStash,
  remote: cmdRemote,
  fetch: cmdFetch,
  pull: cmdPull,
  push: cmdPush,
  bisect: cmdBisect,
};

/** Split an alias definition like `log --oneline --graph` (quotes supported). */
function splitAlias(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export async function runGit(ctx: GitContext, argv: string[]): Promise<number> {
  let args = [...argv];
  // Global options that may precede the subcommand.
  while (args.length && args[0].startsWith('-')) {
    const opt = args.shift()!;
    if (opt === '--version' || opt === '-v') {
      print(ctx, 'git version 2.43.0 (Conglomo Corp. Managed Build, do not update)');
      return 0;
    }
    if (opt === '--help' || opt === '-h') {
      print(ctx, ...generalHelp());
      return 0;
    }
    if (opt === '-c') {
      args.shift();
      continue;
    }
    if (opt === '--no-pager' || opt === '-P' || opt === '--paginate' || opt === '-p') continue;
    if (opt === '-C') {
      print(ctx, c.gray('(git -C is not supported here; cd into the directory instead)'));
      return 129;
    }
    print(ctx, `unknown option: ${opt}`, 'usage: git [--version] [--help] <command> [<args>]');
    return 129;
  }

  if (!args.length) {
    print(ctx, ...generalHelp());
    return 1;
  }

  let [cmd, ...rest] = args;

  if (cmd === 'help') {
    const topic = rest[0];
    if (!topic) {
      print(ctx, ...generalHelp());
      return 0;
    }
    const h = commandHelp(topic);
    if (!h) {
      print(ctx, `No manual entry for git-${topic}`);
      return 1;
    }
    print(ctx, ...h);
    return 0;
  }
  if (cmd === 'version') {
    print(ctx, 'git version 2.43.0 (Conglomo Corp. Managed Build, do not update)');
    return 0;
  }

  // Aliases (git config alias.co checkout)
  if (!COMMANDS[cmd]) {
    const repoAlias = ctx.dir?.initialized ? ctx.dir.getConfig(`alias.${cmd}`) : undefined;
    const alias = repoAlias ?? ctx.world.globalConfig.get(`alias.${cmd}`);
    if (alias) {
      if (alias.startsWith('!')) {
        print(ctx, `fatal: shell aliases are disabled by IT policy (alias.${cmd})`);
        return 128;
      }
      const expanded = splitAlias(alias);
      cmd = expanded[0];
      rest = [...expanded.slice(1), ...rest];
    }
  }

  const fn = COMMANDS[cmd];
  if (!fn) {
    const names = Object.keys(COMMANDS).concat(['help', 'version']);
    const scored = names.map((n) => ({ n, d: levenshtein(cmd, n) })).sort((a, b) => a.d - b.d);
    const best = scored.filter((s) => s.d <= 2 && s.d === scored[0].d);
    print(ctx, `git: '${cmd}' is not a git command. See 'git --help'.`);
    if (best.length) {
      print(ctx, '', best.length === 1 ? 'The most similar command is' : 'The most similar commands are', ...best.map((b) => `\t${b.n}`));
    }
    ctx.world.emit({ type: 'git-typo', typed: cmd });
    return 1;
  }

  if (rest.includes('--help') || (rest.length === 1 && rest[0] === '-h')) {
    const h = commandHelp(cmd);
    if (h) {
      print(ctx, ...h);
      return rest.includes('-h') ? 129 : 0;
    }
  }

  try {
    const code = await fn(ctx, rest);
    ctx.world.emit({ type: 'git', cmd, args: rest, code: code ?? 0 });
    return code ?? 0;
  } catch (e) {
    if (e instanceof GitError) {
      print(ctx, e.output);
      ctx.world.emit({ type: 'git', cmd, args: rest, code: e.code, error: e.output });
      return e.code;
    }
    console.error(e);
    print(ctx, `fatal: internal error in the simulator (${(e as Error).message}). Please report this bug!`);
    return 128;
  }
}
