import { Hub } from './hub';
import { Repository } from './repo';

/**
 * Everything outside a single repository: the clock, the user's global git config,
 * the home directory (which holds project folders), and "GitHub".
 */

export class Clock {
  constructor(public t: number) {}

  now(): number {
    return this.t;
  }

  /** Returns a fresh, strictly increasing timestamp (so commit order is stable). */
  stamp(): number {
    this.t += 1;
    return this.t;
  }

  advance(seconds: number): void {
    this.t += seconds;
  }
}

export interface WorldEvent {
  type: string;
  [key: string]: unknown;
}

export interface TestRun {
  pass: boolean;
  output: string;
}

export class World {
  clock: Clock;
  globalConfig = new Map<string, string>();
  hub = new Hub();
  /** Directories in ~ (each may or may not be a git repo). */
  dirs = new Map<string, Repository>();
  /** Loose files directly in ~. */
  homeFiles = new Map<string, string>();
  user = 'junior';
  host = 'DESKTOP-GARY';
  /** Levels can install a fake test suite for `npm test` (used by bisect puzzles). */
  testRunner: ((repo: Repository) => TestRun) | null = null;
  /** Append-only log of notable things the player did, for the game director. */
  events: WorldEvent[] = [];

  constructor(startTime: number) {
    this.clock = new Clock(startTime);
  }

  emit(e: WorldEvent): void {
    this.events.push(e);
  }

  createDir(name: string, initialized: boolean): Repository {
    const r = new Repository(this, name);
    r.initialized = initialized;
    if (initialized) r.head = { kind: 'branch', name: this.globalConfig.get('init.defaultbranch') ?? 'main' };
    this.dirs.set(name, r);
    return r;
  }

  get homePath(): string {
    return `/home/${this.user}`;
  }
}
