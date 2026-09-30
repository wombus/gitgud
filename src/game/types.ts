import type { WorldEvent } from '../engine/world';
import type { LevelBuilder } from './builder';
import type { CharacterId } from './characters';
import type { Probe } from './probe';

/**
 * Levels are pure data + small predicate functions. The Director runs them;
 * the renderer never needs to know what a level is about.
 */

export interface Msg {
  from: CharacterId;
  text: string;
  /** Extra pause before this message starts "typing", in ms. */
  delay?: number;
  channel?: string;
}

export interface Objective {
  id: string;
  text: string;
  check: (p: Probe) => boolean;
}

export interface ReactionContext {
  probe: Probe;
  /** Events emitted by the last command. */
  events: WorldEvent[];
  command: string;
  output: string;
  code: number;
}

export interface Reaction {
  id: string;
  /** Default true: fire at most once per level attempt. */
  once?: boolean;
  when: (r: ReactionContext) => boolean;
  say: Msg[] | ((r: ReactionContext) => Msg[]);
  /** Optional side effect (e.g. a coworker approves your PR). */
  effect?: (p: Probe) => void;
}

export interface Incident {
  title: string;
  body: string;
  from: CharacterId;
}

export interface FailRule {
  id: string;
  check: (r: ReactionContext) => Incident | null;
}

export interface Debrief {
  title: string;
  points: string[];
}

export interface Level {
  id: string;
  ticket: string;
  title: string;
  /** Office time the level starts ("YYYY-MM-DD HH:MM"); drives in-game lighting. */
  clock: string;
  summary: string;
  concepts: string[];
  /** The directory (repo) the level is about; used by the probe. */
  repo: string;
  /** owner/name of the hosted repo, if any. */
  hosted?: string;
  /**
   * Git identity for this level: undefined = the player's saved identity,
   * null = none (the player must configure it), or a specific person.
   */
  identity?: { name: string; email: string } | null;
  /** Whose machine the terminal is on (default junior@DESKTOP-GARY). */
  machine?: { user: string; host: string };
  setup: (b: LevelBuilder) => void | Promise<void>;
  intro: Msg[];
  objectives: Objective[];
  hints: string[];
  reactions?: Reaction[];
  fails?: FailRule[];
  outro: Msg[];
  debrief: Debrief;
  /** Commands that solve the level (used by tests; never shown). */
  solution: string[];
  /** Editor behaviour for the scripted solution: filename -> new content. */
  solutionEdits?: Record<string, (content: string) => string>;
  /** "Par" number of commands for the performance review. */
  par: number;
}
