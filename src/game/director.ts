import { c, stripAnsi } from '../engine/ansi';
import type { EditorFn } from '../engine/context';
import { clockTime, officeTime } from '../engine/util';
import { World, type WorldEvent } from '../engine/world';
import { Shell, type RunResult } from '../shell/shell';
import { LevelBuilder } from './builder';
import { character, type CharacterId } from './characters';
import { Probe } from './probe';
import type { Incident, Level, Msg, Reaction, ReactionContext } from './types';

/**
 * The Director runs one level: builds its world, delivers IMs on a schedule,
 * evaluates objectives after every command, fires reactions, detects failure,
 * and writes the performance review.
 */

export interface ChatMessage {
  id: number;
  from: CharacterId;
  text: string;
  /** In-game unix time. */
  time: number;
  channel: string;
}

export interface ObjectiveStatus {
  id: string;
  text: string;
  done: boolean;
}

export type Rating = 'Exceeds Expectations' | 'Meets Expectations' | 'Needs Improvement';

export interface LevelReport {
  level: Level;
  commands: number;
  workCommands: number;
  errors: number;
  hints: number;
  seconds: number;
  rating: Rating;
  stars: number;
}

export interface DirectorCallbacks {
  onMessage?(m: ChatMessage): void;
  onTyping?(who: CharacterId | null): void;
  onObjectives?(list: ObjectiveStatus[]): void;
  onComplete?(report: LevelReport): void;
  onFail?(incident: Incident): void;
  onRestartRequest?(): void;
}

export type Scheduler = (fn: () => void, ms: number) => void;

export interface DirectorOptions {
  editor: EditorFn;
  identity?: { name: string; email: string } | null;
  callbacks?: DirectorCallbacks;
  /** Defaults to setTimeout. Tests pass an immediate scheduler. */
  scheduler?: Scheduler;
  /** Multiply all message delays (0 = instant). */
  pace?: number;
}

/** Commands that only look at things; they don't count against you in the review. */
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'reflog', 'blame', 'shortlog', 'help', 'version']);
const READ_ONLY_SHELL = new Set(['ls', 'cat', 'pwd', 'cd', 'clear', 'help', 'hint', 'task', 'tasks', 'ticket', 'history', 'tree', 'grep', 'head', 'tail', 'whoami', 'date', 'man', 'wc']);

function isWorkCommand(line: string): boolean {
  const words = line.trim().split(/\s+/);
  const [cmd, sub, third] = words;
  if (READ_ONLY_SHELL.has(cmd)) return false;
  if (cmd === 'git') {
    if (!sub || READ_ONLY_GIT.has(sub)) return false;
    if (sub === 'branch' && (!third || third.startsWith('-v') || third === '-a' || third === '-r' || third === '--list')) return false;
    if (sub === 'stash' && (third === 'list' || third === 'show')) return false;
    if (sub === 'remote' && (!third || third === '-v' || third === 'show')) return false;
    if (sub === 'config' && words.length <= 3) return false;
    return true;
  }
  if (cmd === 'gh') return !['list', 'view', 'status', 'diff'].includes(third ?? '') || !sub;
  return true;
}

const GLOBAL_REACTIONS: Reaction[] = [
  {
    id: 'g-sudo',
    when: (r) => r.events.some((e) => e.type === 'sudo'),
    say: [
      { from: 'it', text: "🎫 Ticket #88213 auto-created: “User attempted privilege escalation.” Status: Escalated to your manager. Have a great day!" },
      { from: 'dana', text: "Just got an automated email about you and `sudo`? Let's add it to our 1:1 agenda. 🙂", delay: 1500 },
    ],
  },
  {
    id: 'g-vim',
    when: (r) => r.events.some((e) => e.type === 'vim-attempt'),
    say: [{ from: 'greg', text: 'lol. vim. we lost an intern in there in 2019. they said he could hear us but couldn\'t get out.' }],
  },
  {
    id: 'g-rmroot',
    when: (r) => r.events.some((e) => e.type === 'rm-root'),
    say: [{ from: 'priya', text: 'did you just try to `rm -rf` the whole machine. on your first week. i\'m not even mad. i\'m a little impressed.' }],
  },
  {
    id: 'g-typo',
    when: (r) => r.events.some((e) => e.type === 'git-typo'),
    say: [{ from: 'todd', text: 'haha i type `git stauts` like 40 times a day!! we\'re basically the same person 🙌' }],
  },
  {
    id: 'g-exit',
    when: (r) => /^(exit|logout)\b/.test(r.command),
    say: [{ from: 'dana', text: 'Heading out already? Bold choice. 🙂' }],
  },
  {
    id: 'g-lazy-message',
    when: (r) =>
      r.events.some((e) => e.type === 'commit' && /^(fix|wip|update|changes|stuff|asdf|test|\.|fixes|fixed|done|commit)$/i.test(String(e.message).trim())),
    say: (r) => {
      const e = r.events.find((x) => x.type === 'commit')!;
      return [{ from: 'greg', text: `“${String(e.message).trim()}”. very descriptive. future you, reading \`git log\` at 2am during an outage, will be thrilled.` }];
    },
  },
  {
    id: 'g-force',
    when: (r) => r.events.some((e) => e.type === 'push' && e.forced),
    say: [{ from: 'greg', text: 'i felt that force push in my soul. (if it was your own branch: fine. `--force-with-lease` is the polite version.)' }],
  },
  {
    id: 'g-blame',
    when: (r) => r.events.some((e) => e.type === 'blame'),
    say: [{ from: 'greg', text: 'if that blame says “Greg Hollis” it\'s because i was cleaning up someone else\'s mess. context matters.' }],
  },
  {
    id: 'g-notrepo',
    when: (r) => /not a git repository/.test(r.output),
    say: [{ from: 'todd', text: 'ooh “not a git repository” means you\'re not inside the project folder! `cd` into it first (took me 2 weeks to figure that out lol)' }],
  },
  {
    id: 'g-sl',
    when: (r) => /^sl\b/.test(r.command),
    say: [{ from: 'priya', text: 'choo choo.' }],
  },
];

export class Director {
  world!: World;
  shell!: Shell;
  probe!: Probe;
  state: 'loading' | 'playing' | 'complete' | 'failed' = 'loading';
  messages: ChatMessage[] = [];
  hintsUsed = 0;
  commands = 0;
  workCommands = 0;
  errors = 0;
  startedAt = Date.now();

  private msgId = 0;
  private queue: Msg[] = [];
  private delivering = false;
  private fired = new Set<string>();
  private eventCursor = 0;
  private schedule: Scheduler;
  private pace: number;

  constructor(
    public level: Level,
    private opts: DirectorOptions,
  ) {
    this.schedule = opts.scheduler ?? ((fn, ms) => setTimeout(fn, ms));
    this.pace = opts.pace ?? 1;
  }

  get cb(): DirectorCallbacks {
    return this.opts.callbacks ?? {};
  }

  /** Build the level's world. Intro messages start now unless `intro: false` (then call introduce()). */
  async start(opts: { intro?: boolean } = {}): Promise<void> {
    const lvl = this.level;
    this.world = new World(officeTime(lvl.clock));
    if (lvl.machine) {
      this.world.user = lvl.machine.user;
      this.world.host = lvl.machine.host;
    }
    const fallback = this.opts.identity ?? { name: 'Junior Dev', email: 'junior@conglomo.com' };
    const id = lvl.identity === undefined ? fallback : lvl.identity;
    if (id) {
      this.world.globalConfig.set('user.name', id.name);
      this.world.globalConfig.set('user.email', id.email);
    }
    this.world.globalConfig.set('init.defaultbranch', 'main');
    this.shell = new Shell(this.world, this.opts.editor, {
      gameCommand: (name, args) => this.gameCommand(name, args),
      gameCommandNames: ['hint', 'task'],
    });
    const b = new LevelBuilder(this.world, this.shell);
    await lvl.setup(b);
    // Setup may have moved the clock around while building history.
    this.world.clock.t = officeTime(lvl.clock);
    this.world.events = [];
    this.eventCursor = 0;
    this.probe = new Probe(this.world, this.shell, lvl.repo, lvl.hosted);
    this.state = 'playing';
    this.startedAt = Date.now();
    this.emitObjectives();
    if (opts.intro !== false) this.introduce();
  }

  introduce(): void {
    this.say(this.level.intro);
  }

  /** Advance the in-game clock (the UI calls this once per real second). */
  tick(seconds = 1): void {
    if (this.state === 'playing') this.world.clock.advance(seconds);
  }

  clockLabel(): string {
    return clockTime(this.world.clock.now());
  }

  objectiveStatus(): ObjectiveStatus[] {
    return this.level.objectives.map((o) => {
      let done = false;
      try {
        done = o.check(this.probe);
      } catch {
        done = false;
      }
      return { id: o.id, text: o.text, done };
    });
  }

  private emitObjectives(): ObjectiveStatus[] {
    const st = this.objectiveStatus();
    this.cb.onObjectives?.(st);
    return st;
  }

  /* ----------------------------- messaging ------------------------------ */

  say(msgs: Msg[]): void {
    this.queue.push(...msgs);
    if (!this.delivering) this.deliverNext();
  }

  private typingTime(m: Msg): number {
    return Math.min(3200, 500 + m.text.length * 18);
  }

  private deliverNext(): void {
    const m = this.queue.shift();
    if (!m) {
      this.delivering = false;
      this.cb.onTyping?.(null);
      this.afterQueueDrained();
      return;
    }
    this.delivering = true;
    const pause = (m.delay ?? 250) * this.pace;
    this.schedule(() => {
      this.cb.onTyping?.(m.from);
      this.schedule(() => {
        const msg: ChatMessage = {
          id: ++this.msgId,
          from: m.from,
          text: m.text,
          time: this.world.clock.now(),
          channel: m.channel ?? m.from,
        };
        this.messages.push(msg);
        this.cb.onTyping?.(null);
        this.cb.onMessage?.(msg);
        this.deliverNext();
      }, this.typingTime(m) * this.pace);
    }, pause);
  }

  private pendingComplete: LevelReport | null = null;

  private afterQueueDrained(): void {
    if (this.pendingComplete) {
      const r = this.pendingComplete;
      this.pendingComplete = null;
      this.schedule(() => this.cb.onComplete?.(r), 900 * this.pace);
    }
  }

  /* --------------------------- running commands ------------------------- */

  async runCommand(line: string): Promise<RunResult> {
    if (this.state !== 'playing') {
      return { lines: [c.gray('(This ticket is closed. Use the menu to continue.)')], code: 1 };
    }
    const res = await this.shell.run(line);
    const trimmed = line.trim();
    if (trimmed) {
      this.commands++;
      if (isWorkCommand(trimmed)) this.workCommands++;
      if (res.code !== 0 && !/^(hint|task)/.test(trimmed)) this.errors++;
    }
    this.evaluate(trimmed, res);
    return res;
  }

  /** Run reactions, fail rules and objectives after something happened. */
  evaluate(command = '', res: RunResult = { lines: [], code: 0 }): void {
    if (this.state !== 'playing') return;
    const events: WorldEvent[] = this.world.events.slice(this.eventCursor);
    this.eventCursor = this.world.events.length;
    const ctx: ReactionContext = {
      probe: this.probe,
      events,
      command,
      output: res.lines.map(stripAnsi).join('\n'),
      code: res.code,
    };

    // Failure first: some mistakes end the ticket immediately.
    const fails = [...(this.level.fails ?? []), ...globalFails(this.level)];
    for (const f of fails) {
      let incident: Incident | null = null;
      try {
        incident = f.check(ctx);
      } catch {
        incident = null;
      }
      if (incident) {
        this.state = 'failed';
        this.queue = [];
        this.cb.onTyping?.(null);
        this.schedule(() => this.cb.onFail?.(incident!), 400 * this.pace);
        return;
      }
    }

    for (const r of [...(this.level.reactions ?? []), ...GLOBAL_REACTIONS]) {
      const once = r.once !== false;
      if (once && this.fired.has(r.id)) continue;
      let hit = false;
      try {
        hit = r.when(ctx);
      } catch {
        hit = false;
      }
      if (!hit) continue;
      this.fired.add(r.id);
      r.effect?.(this.probe);
      this.say(typeof r.say === 'function' ? r.say(ctx) : r.say);
    }

    const st = this.emitObjectives();
    if (st.every((o) => o.done)) this.complete();
  }

  /** Re-check objectives without a command (e.g. after a scripted coworker action). */
  recheck(): void {
    this.evaluate();
  }

  private complete(): void {
    this.state = 'complete';
    const seconds = Math.round((Date.now() - this.startedAt) / 1000);
    const par = this.level.par;
    let stars = 1;
    if (this.hintsUsed === 0 && this.workCommands <= par + 2 && this.errors <= 3) stars = 3;
    else if (this.hintsUsed <= 1 && this.workCommands <= par * 2 + 3) stars = 2;
    const rating: Rating = stars === 3 ? 'Exceeds Expectations' : stars === 2 ? 'Meets Expectations' : 'Needs Improvement';
    this.pendingComplete = {
      level: this.level,
      commands: this.commands,
      workCommands: this.workCommands,
      errors: this.errors,
      hints: this.hintsUsed,
      seconds,
      rating,
      stars,
    };
    this.say(this.level.outro);
  }

  /* ---------------------------- game commands --------------------------- */

  taskLines(): string[] {
    const st = this.objectiveStatus();
    return [
      c.bold(`${this.level.ticket}: ${this.level.title}`),
      ...st.map((o) => `  ${o.done ? c.green('[x]') : c.yellow('[ ]')} ${o.text}`),
      c.gray(`  (${st.filter((o) => o.done).length}/${st.length} done — type ${c.cyan('hint')} if you're stuck)`),
    ];
  }

  hint(): string[] {
    const hints = this.level.hints;
    if (!hints.length) return [c.gray('No hints for this one. Greg says: "read the error message."')];
    const i = Math.min(this.hintsUsed, hints.length - 1);
    if (this.hintsUsed < hints.length) this.hintsUsed++;
    return [c.yellow(`Hint ${i + 1}/${hints.length}`) + c.gray(' (hints are noted in your performance review)'), ...hints[i].split('\n').map((l) => `  ${l}`)];
  }

  private gameCommand(name: string, args: string[]): string[] | null {
    if (name === 'hint' || name === 'hints') return this.hint();
    if (name === 'task' || name === 'tasks' || name === 'ticket' || name === 'todo') return this.taskLines();
    if (name === 'restart-level') {
      this.cb.onRestartRequest?.();
      return [c.gray('Restarting ticket...')];
    }
    if (name === 'pingr' || name === 'messages') {
      const last = this.messages.slice(-Number(args[0] ?? 8));
      if (!last.length) return [c.gray('No messages.')];
      return last.map((m) => `${c.bold(character(m.from).name)} ${c.gray(clockTime(m.time))}: ${m.text.replace(/`([^`]+)`/g, (_, x) => c.cyan(x))}`);
    }
    return null;
  }
}

function globalFails(level: Level): Array<{ id: string; check: (r: ReactionContext) => Incident | null }> {
  return [
    {
      id: 'g-rm-git',
      check: (r) =>
        r.events.some((e) => e.type === 'rm-git' && e.dir === level.repo)
          ? {
              from: 'priya',
              title: 'Repository Deleted',
              body:
                'You ran `rm -rf .git`. That hidden folder *is* the repository: every commit, branch, stash and reflog entry lives there. ' +
                'Your files are still on disk, but git has no idea they ever had a history. Anything you had not pushed is gone for good.',
            }
          : null,
    },
  ];
}
