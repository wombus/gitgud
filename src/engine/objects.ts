import { sha1 } from './sha1';

/**
 * Git's object model, simplified.
 *
 * Real git has four object types: blob (file contents), tree (a directory listing),
 * commit (a snapshot + metadata + parent pointers), and tag (an annotated label).
 *
 * The one big simplification here: our trees are *flat*. A tree maps full paths
 * like "src/app.js" directly to blob hashes instead of nesting sub-trees. Nothing
 * a player can observe depends on nesting, and flat trees make diffing and merging
 * dramatically simpler.
 */

export type Hash = string;

export interface Person {
  name: string;
  email: string;
}

export interface Signature extends Person {
  /** Unix timestamp in seconds. */
  time: number;
}

export interface BlobObject {
  type: 'blob';
  content: string;
}

export interface TreeObject {
  type: 'tree';
  /** path -> blob hash */
  entries: Record<string, Hash>;
}

export interface CommitObject {
  type: 'commit';
  tree: Hash;
  parents: Hash[];
  author: Signature;
  committer: Signature;
  message: string;
}

export interface TagObject {
  type: 'tag';
  object: Hash;
  tag: string;
  tagger: Signature;
  message: string;
}

export type GitObject = BlobObject | TreeObject | CommitObject | TagObject;

/** Tree contents as a plain Map, which is how most of the engine likes to work with them. */
export type FileMap = Map<string, Hash>;

export const EMPTY_TREE_ENTRIES: Record<string, Hash> = {};

function sigLine(s: Signature): string {
  return `${s.name} <${s.email}> ${s.time} -0500`;
}

/** Serialize an object roughly the way git does, so hashes behave like real ones. */
export function serialize(obj: GitObject): string {
  switch (obj.type) {
    case 'blob':
      return `blob ${obj.content.length}\0${obj.content}`;
    case 'tree': {
      const body = Object.keys(obj.entries)
        .sort()
        .map((p) => `100644 blob ${obj.entries[p]}\t${p}`)
        .join('\n');
      return `tree ${body.length}\0${body}`;
    }
    case 'commit': {
      const lines = [`tree ${obj.tree}`];
      for (const p of obj.parents) lines.push(`parent ${p}`);
      lines.push(`author ${sigLine(obj.author)}`);
      lines.push(`committer ${sigLine(obj.committer)}`);
      const body = `${lines.join('\n')}\n\n${obj.message}`;
      return `commit ${body.length}\0${body}`;
    }
    case 'tag': {
      const body = `object ${obj.object}\ntype commit\ntag ${obj.tag}\ntagger ${sigLine(obj.tagger)}\n\n${obj.message}`;
      return `tag ${body.length}\0${body}`;
    }
  }
}

export function hashObject(obj: GitObject): Hash {
  return sha1(serialize(obj));
}

/**
 * Content-addressed object database. Objects are immutable once written, so they
 * can be safely shared (by copying hashes) between a local repo and its remote.
 */
export class ObjectStore {
  private objects = new Map<Hash, GitObject>();

  put(obj: GitObject): Hash {
    const h = hashObject(obj);
    if (!this.objects.has(h)) this.objects.set(h, obj);
    return h;
  }

  putBlob(content: string): Hash {
    return this.put({ type: 'blob', content });
  }

  putTree(files: FileMap | Record<string, Hash>): Hash {
    const entries: Record<string, Hash> = {};
    const iter = files instanceof Map ? files.entries() : Object.entries(files);
    for (const [p, h] of iter) entries[p] = h;
    return this.put({ type: 'tree', entries });
  }

  has(h: Hash): boolean {
    return this.objects.has(h);
  }

  get(h: Hash): GitObject | undefined {
    return this.objects.get(h);
  }

  /** Raw access used when copying objects between stores. */
  rawSet(h: Hash, obj: GitObject): void {
    this.objects.set(h, obj);
  }

  blob(h: Hash): string {
    const o = this.objects.get(h);
    if (!o || o.type !== 'blob') throw new Error(`not a blob: ${h}`);
    return o.content;
  }

  tree(h: Hash): FileMap {
    const o = this.objects.get(h);
    if (!o || o.type !== 'tree') throw new Error(`not a tree: ${h}`);
    return new Map(Object.entries(o.entries));
  }

  commit(h: Hash): CommitObject {
    const o = this.objects.get(h);
    if (!o || o.type !== 'commit') throw new Error(`not a commit: ${h}`);
    return o;
  }

  isCommit(h: Hash): boolean {
    return this.objects.get(h)?.type === 'commit';
  }

  /** Follow annotated tags until we reach a non-tag object. */
  peel(h: Hash): Hash {
    let cur = h;
    for (let i = 0; i < 10; i++) {
      const o = this.objects.get(cur);
      if (o?.type === 'tag') cur = o.object;
      else return cur;
    }
    return cur;
  }

  /** All object hashes that start with the given (lowercase hex) prefix. */
  findByPrefix(prefix: string): Hash[] {
    const out: Hash[] = [];
    for (const h of this.objects.keys()) if (h.startsWith(prefix)) out.push(h);
    return out;
  }

  allHashes(): Hash[] {
    return [...this.objects.keys()];
  }

  /** Files of a commit's snapshot. */
  commitFiles(commitHash: Hash): FileMap {
    return this.tree(this.commit(commitHash).tree);
  }

  /**
   * Copy every object reachable from `tips` in `from` into this store. This is what
   * push/fetch/clone do under the hood (minus the packfile compression).
   * Returns the number of objects that were new to this store.
   */
  copyReachable(from: ObjectStore, tips: Hash[]): number {
    let copied = 0;
    const stack = [...tips];
    const seen = new Set<Hash>();
    while (stack.length) {
      const h = stack.pop()!;
      if (seen.has(h)) continue;
      seen.add(h);
      const o = from.get(h);
      if (!o) continue;
      if (!this.objects.has(h)) {
        this.objects.set(h, o);
        copied++;
      } else if (o.type === 'commit') {
        // Already have this commit, therefore we already have its whole history.
        continue;
      }
      if (o.type === 'commit') {
        stack.push(o.tree, ...o.parents);
      } else if (o.type === 'tree') {
        for (const b of Object.values(o.entries)) stack.push(b);
      } else if (o.type === 'tag') {
        stack.push(o.object);
      }
    }
    return copied;
  }
}

export function shortHash(h: Hash): string {
  return h.slice(0, 7);
}

/** First line of a commit message (what `git log --oneline` shows). */
export function subject(message: string): string {
  return message.split('\n')[0];
}
