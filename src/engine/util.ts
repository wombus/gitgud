/** Shared helpers: errors, dates, pathspecs, small string utilities. */

/**
 * Thrown by commands to abort with git-style output. `code` mirrors git's exit
 * codes: 128 for "fatal:" errors, 1 for ordinary failures.
 */
export class GitError extends Error {
  constructor(
    public output: string,
    public code = 128,
  ) {
    super(output);
  }
}

export const fatal = (msg: string) => new GitError(`fatal: ${msg}`, 128);
export const failure = (msg: string, code = 1) => new GitError(msg, code);

/* ------------------------------------------------------------------------- */
/* Dates: the office is in US Eastern time (-0500), always, because IT said so. */
/* ------------------------------------------------------------------------- */

const TZ_OFFSET = -5 * 3600;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function local(t: number): Date {
  return new Date((t + TZ_OFFSET) * 1000);
}

/** "Mon Mar 2 09:14:00 2026 -0500" — the format `git log` uses. */
export function gitDate(t: number): string {
  const d = local(t);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} -0500`;
}

/** "2026-03-02 09:14:00 -0500" */
export function isoDate(t: number): string {
  const d = local(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())} -0500`;
}

export function shortDate(t: number): string {
  const d = local(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function clockTime(t: number): string {
  const d = local(t);
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${pad(d.getUTCMinutes())} ${ampm}`;
}

export function relativeTime(t: number, now: number): string {
  const s = Math.max(0, now - t);
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'} ago`;
  if (s < 90) return s <= 1 ? 'just now' : unit(s, 'second');
  if (s < 90 * 60) return unit(Math.round(s / 60), 'minute');
  if (s < 36 * 3600) return unit(Math.round(s / 3600), 'hour');
  if (s < 14 * 86400) return unit(Math.round(s / 86400), 'day');
  if (s < 60 * 86400) return unit(Math.round(s / (7 * 86400)), 'week');
  return unit(Math.round(s / (30 * 86400)), 'month');
}

/** Parse a "YYYY-MM-DD HH:MM" local office time to a unix timestamp. */
export function officeTime(s: string): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?$/.exec(s);
  if (!m) throw new Error(`bad office time: ${s}`);
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) / 1000;
  return utc - TZ_OFFSET;
}

/* ------------------------------------------------------------------------- */
/* Paths & pathspecs                                                          */
/* ------------------------------------------------------------------------- */

/** Normalize a path relative to `cwd` (both repo-relative). Returns null if it escapes the repo. */
export function resolveRepoPath(cwd: string, p: string): string | null {
  const parts = (p.startsWith('/') ? p.slice(1) : cwd ? `${cwd}/${p}` : p).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function hasGlob(s: string): boolean {
  return /[*?]/.test(s);
}

/**
 * Does repo path `path` match pathspec `spec` (already resolved relative to the
 * repo root)? An empty spec matches everything, a directory matches everything
 * beneath it, and git pathspec globs (unlike shell globs) match across "/".
 */
export function matchPathspec(spec: string, path: string): boolean {
  if (spec === '') return true;
  if (path === spec || path.startsWith(spec + '/')) return true;
  if (hasGlob(spec)) {
    const loose = new RegExp(globToRegExp(spec).source.replace(/\[\^\/\]\*/g, '.*'));
    return loose.test(path);
  }
  return false;
}

/** Shell-style glob (no crossing "/") used for .gitignore patterns and shell expansion. */
export function globMatch(glob: string, name: string): boolean {
  return globToRegExp(glob).test(name);
}

/**
 * A small subset of .gitignore semantics: blank lines and comments, negation,
 * trailing-slash directory patterns, anchored ("/foo") and unanchored patterns.
 */
export function isIgnored(path: string, gitignore: string | undefined): boolean {
  if (!gitignore) return false;
  let ignored = false;
  for (let raw of gitignore.split('\n')) {
    raw = raw.trim();
    if (!raw || raw.startsWith('#')) continue;
    let negate = false;
    if (raw.startsWith('!')) {
      negate = true;
      raw = raw.slice(1);
    }
    let dirOnly = false;
    if (raw.endsWith('/')) {
      dirOnly = true;
      raw = raw.slice(0, -1);
    }
    const anchored = raw.startsWith('/') || raw.includes('/');
    const pat = raw.startsWith('/') ? raw.slice(1) : raw;
    const segs = path.split('/');
    let hit = false;
    if (anchored) {
      // Match the pattern against the path or any of its leading directories.
      for (let i = 1; i <= segs.length; i++) {
        const prefix = segs.slice(0, i).join('/');
        const isDir = i < segs.length;
        if (globMatch(pat, prefix) && (!dirOnly || isDir)) hit = true;
      }
    } else {
      segs.forEach((seg, i) => {
        const isDir = i < segs.length - 1;
        if (globMatch(pat, seg) && (!dirOnly || isDir)) hit = true;
      });
    }
    if (hit) ignored = !negate;
  }
  return ignored;
}

/* ------------------------------------------------------------------------- */

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function plural(n: number, word: string, pluralWord = word + 's'): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Tiny argument parser helper: pops flags we recognize, leaves the rest. */
export class Args {
  rest: string[] = [];
  afterDashDash: string[] | null = null;
  private flags = new Map<string, string | true>();

  constructor(
    argv: string[],
    /** flags that take a value, e.g. ['-m', '--message'] */
    valueFlags: string[] = [],
  ) {
    const takesValue = new Set(valueFlags);
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') {
        this.afterDashDash = argv.slice(i + 1);
        break;
      }
      if (a.startsWith('--') && a.includes('=')) {
        const eq = a.indexOf('=');
        this.push(a.slice(0, eq), a.slice(eq + 1));
      } else if (takesValue.has(a)) {
        if (i + 1 >= argv.length) throw fatal(`option '${a.replace(/^-+/, '')}' requires a value`);
        this.push(a, argv[++i]);
      } else if (/^-[a-zA-Z]{2,}$/.test(a) && !takesValue.has(a)) {
        // Bundled short flags: -am "msg" => -a -m "msg"; -n5 style isn't supported.
        const letters = a.slice(1).split('');
        for (let j = 0; j < letters.length; j++) {
          const f = `-${letters[j]}`;
          if (takesValue.has(f)) {
            const inline = letters.slice(j + 1).join('');
            if (inline) this.push(f, inline);
            else {
              if (i + 1 >= argv.length) throw fatal(`switch '${letters[j]}' requires a value`);
              this.push(f, argv[++i]);
            }
            break;
          }
          this.push(f, true);
        }
      } else if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
        this.push(a, true);
      } else {
        this.rest.push(a);
      }
    }
  }

  private multi = new Map<string, string[]>();
  private push(k: string, v: string | true) {
    this.flags.set(k, v);
    if (typeof v === 'string') {
      const arr = this.multi.get(k) ?? [];
      arr.push(v);
      this.multi.set(k, arr);
    }
  }

  has(...names: string[]): boolean {
    return names.some((n) => this.flags.has(n));
  }

  value(...names: string[]): string | undefined {
    for (const n of names) {
      const v = this.flags.get(n);
      if (typeof v === 'string') return v;
    }
    return undefined;
  }

  values(...names: string[]): string[] {
    return names.flatMap((n) => this.multi.get(n) ?? []);
  }

  /** Every flag given, for unknown-option detection. */
  allFlags(): string[] {
    return [...this.flags.keys()];
  }
}
