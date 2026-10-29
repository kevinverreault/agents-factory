import { relative, isAbsolute } from 'node:path';
import type { Clone, Git } from '../git/git.ts';

type CloneSetup = { originUrl?: string | null; defaultBranch?: string | null };

// Clones that exist only in memory: a test adds, moves and removes them.
export class FakeGit implements Git {
  private readonly clones = new Map<string, Clone>();

  addClone(path: string, { originUrl = null, defaultBranch = null }: CloneSetup = {}): void {
    this.clones.set(path, { path, originUrl, defaultBranch });
  }

  moveClone(from: string, to: string): void {
    const clone = this.clones.get(from);
    if (!clone) throw new Error(`There is no clone at ${from}.`);
    this.clones.delete(from);
    this.clones.set(to, { ...clone, path: to });
  }

  async inspectClone(path: string): Promise<Clone | null> {
    for (const clone of this.clones.values()) if (isWithin(clone.path, path)) return { ...clone };
    return null;
  }
}

function isWithin(top: string, path: string): boolean {
  const rest = relative(top, path);
  return !rest.startsWith('..') && !isAbsolute(rest);
}
