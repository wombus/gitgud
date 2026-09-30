import type { Repository } from '../engine/repo';
import type { World } from '../engine/world';

/**
 * The virtual filesystem the shell sees:
 *
 *   /home/junior/            <- ~ (loose files live in world.homeFiles)
 *   /home/junior/<project>/  <- a Repository's working tree
 *   /home/junior/<project>/.git/  <- look but don't touch
 *
 * Paths are always resolved to a Location: which project (or home) and the path
 * inside it. Directories inside a project are implicit (derived from file paths),
 * plus any empty ones made with mkdir.
 */

export interface Cwd {
  dir: string | null;
  sub: string;
}

export interface Location {
  /** null = home directory itself; undefined project = path above home (outside our world) */
  dir: Repository | null;
  dirName: string | null;
  /** Path inside the project ('' = project root). For home: the file name. */
  path: string;
  /** Resolved above /home/junior — not a place we model. */
  outside?: boolean;
}

export class VirtualFS {
  constructor(private world: World) {}

  get home(): string {
    return this.world.homePath;
  }

  /** Normalize to a list of segments under ~ (null if it escapes ~). */
  segments(cwd: Cwd, p: string): string[] | null {
    let base: string[];
    let rest = p;
    if (p === '~' || p.startsWith('~/')) {
      base = [];
      rest = p.slice(1);
    } else if (p.startsWith('/')) {
      const home = this.home;
      if (p === home || p.startsWith(home + '/')) {
        base = [];
        rest = p.slice(home.length);
      } else return null;
    } else {
      base = cwd.dir ? [cwd.dir, ...(cwd.sub ? cwd.sub.split('/') : [])] : [];
    }
    const out = [...base];
    for (const part of rest.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!out.length) return null;
        out.pop();
      } else out.push(part);
    }
    return out;
  }

  locate(cwd: Cwd, p: string): Location {
    const segs = this.segments(cwd, p);
    if (!segs) return { dir: null, dirName: null, path: '', outside: true };
    if (!segs.length) return { dir: null, dirName: null, path: '' };
    const project = this.world.dirs.get(segs[0]);
    if (project) return { dir: project, dirName: segs[0], path: segs.slice(1).join('/') };
    return { dir: null, dirName: null, path: segs.join('/') };
  }

  displayPath(cwd: Cwd): string {
    if (!cwd.dir) return '~';
    return `~/${cwd.dir}${cwd.sub ? '/' + cwd.sub : ''}`;
  }

  absPath(cwd: Cwd): string {
    if (!cwd.dir) return this.home;
    return `${this.home}/${cwd.dir}${cwd.sub ? '/' + cwd.sub : ''}`;
  }

  isGitPath(loc: Location): boolean {
    return !!loc.dir && (loc.path === '.git' || loc.path.startsWith('.git/'));
  }

  isDir(loc: Location): boolean {
    if (loc.outside) return false;
    if (!loc.dir) {
      // ~ itself, or a (non-project) path in home
      return loc.path === '';
    }
    if (loc.path === '') return true;
    if (loc.path === '.git') return loc.dir.initialized;
    const prefix = loc.path + '/';
    for (const k of loc.dir.worktree.keys()) if (k.startsWith(prefix)) return true;
    for (const d of loc.dir.emptyDirs) if (d === loc.path || d.startsWith(prefix)) return true;
    return false;
  }

  isFile(loc: Location): boolean {
    if (loc.outside) return false;
    if (!loc.dir) return this.world.homeFiles.has(loc.path);
    return loc.dir.worktree.has(loc.path);
  }

  exists(loc: Location): boolean {
    return this.isDir(loc) || this.isFile(loc);
  }

  read(loc: Location): string | undefined {
    if (!loc.dir) return this.world.homeFiles.get(loc.path);
    return loc.dir.worktree.get(loc.path);
  }

  write(loc: Location, content: string): void {
    if (!loc.dir) {
      this.world.homeFiles.set(loc.path, content);
      return;
    }
    loc.dir.worktree.set(loc.path, content);
    // Writing a file makes its parents real; drop any now-redundant empty-dir markers.
    const segs = loc.path.split('/');
    for (let i = 1; i < segs.length; i++) loc.dir.emptyDirs.delete(segs.slice(0, i).join('/'));
  }

  remove(loc: Location): void {
    if (!loc.dir) this.world.homeFiles.delete(loc.path);
    else loc.dir.worktree.delete(loc.path);
  }

  /** Entries directly inside a directory: names, with a flag for subdirectories. */
  list(loc: Location, all = false): Array<{ name: string; dir: boolean }> {
    const out = new Map<string, boolean>();
    if (!loc.dir) {
      if (loc.path !== '') return [];
      for (const d of this.world.dirs.keys()) out.set(d, true);
      for (const f of this.world.homeFiles.keys()) out.set(f, false);
    } else {
      const prefix = loc.path ? loc.path + '/' : '';
      if (!loc.path && all && loc.dir.initialized) out.set('.git', true);
      const add = (p: string, isFileEntry: boolean) => {
        if (!p.startsWith(prefix)) return;
        const rest = p.slice(prefix.length);
        if (!rest) return;
        const slash = rest.indexOf('/');
        if (slash >= 0) out.set(rest.slice(0, slash), true);
        else if (!out.has(rest)) out.set(rest, !isFileEntry);
      };
      for (const k of loc.dir.worktree.keys()) add(k, true);
      for (const d of loc.dir.emptyDirs) add(d, false);
    }
    return [...out.entries()]
      .filter(([n]) => all || !n.startsWith('.'))
      .map(([name, dir]) => ({ name, dir }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** All files (recursively) under a directory location, as project paths. */
  walkFiles(loc: Location): string[] {
    if (!loc.dir) return loc.path === '' ? [...this.world.homeFiles.keys()] : [];
    const prefix = loc.path ? loc.path + '/' : '';
    return [...loc.dir.worktree.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
