import { relative, isAbsolute } from 'node:path';
import { GitError, type Clone, type Git, type Worktree } from '../git/git.ts';

type CloneSetup = { originUrl?: string | null; defaultBranch?: string | null };

type FakeClone = Clone & {
  // Branch tips on origin, and what the clone last fetched of them.
  origin: Map<string, string>;
  fetched: Map<string, string>;
  branches: Map<string, string>;
  worktrees: Worktree[];
  // Set while origin can't be reached, with what git would say.
  unreachable: string | null;
};

// Clones that exist only in memory: a test adds, moves and removes them, and
// moves their origin on.
export class FakeGit implements Git {
  private readonly clones = new Map<string, FakeClone>();
  private commits = 0;

  addClone(path: string, { originUrl = null, defaultBranch = null }: CloneSetup = {}): void {
    const clone: FakeClone = {
      path,
      originUrl,
      defaultBranch,
      origin: new Map(),
      fetched: new Map(),
      branches: new Map(),
      worktrees: [],
      unreachable: null,
    };
    if (defaultBranch) {
      const start = this.commit();
      clone.origin.set(defaultBranch, start);
      clone.fetched.set(defaultBranch, start);
      clone.branches.set(defaultBranch, start);
    }
    this.clones.set(path, clone);
  }

  moveClone(from: string, to: string): void {
    const clone = this.cloneAt(from);
    this.clones.delete(from);
    this.clones.set(to, { ...clone, path: to });
  }

  // Adds a commit to `branch` on origin, which the clone hasn't fetched yet.
  advanceOrigin(clonePath: string, branch: string): string {
    const tip = this.commit();
    this.cloneAt(clonePath).origin.set(branch, tip);
    return tip;
  }

  // Origin stops answering the clone's fetches.
  cutOffOrigin(clonePath: string, reason: string): void {
    this.cloneAt(clonePath).unreachable = reason;
  }

  async inspectClone(path: string): Promise<Clone | null> {
    for (const { path: top, originUrl, defaultBranch } of this.clones.values()) {
      if (isWithin(top, path)) return { path: top, originUrl, defaultBranch };
    }
    return null;
  }

  async fetch(clonePath: string, branch: string): Promise<void> {
    const clone = this.cloneAt(clonePath);
    if (clone.unreachable) throw new GitError(clone.unreachable);
    const tip = clone.origin.get(branch);
    if (!tip) throw new GitError(`fatal: couldn't find remote ref ${branch}`);
    clone.fetched.set(branch, tip);
  }

  async addWorktree(clonePath: string, { path, branch, startPoint }: { path: string; branch: string; startPoint: string }): Promise<void> {
    const clone = this.cloneAt(clonePath);
    if (clone.branches.has(branch)) throw new GitError(`fatal: a branch named '${branch}' already exists`);
    if (clone.worktrees.some((worktree) => worktree.path === path)) throw new GitError(`fatal: '${path}' already exists`);
    const head = startPoint.startsWith('origin/') ? clone.fetched.get(startPoint.slice('origin/'.length)) : clone.branches.get(startPoint);
    if (!head) throw new GitError(`fatal: invalid reference: ${startPoint}`);
    clone.branches.set(branch, head);
    clone.worktrees.push({ path, branch, head });
  }

  async worktrees(clonePath: string): Promise<Worktree[]> {
    return this.cloneAt(clonePath).worktrees.map((worktree) => ({ ...worktree }));
  }

  private cloneAt(path: string): FakeClone {
    const clone = this.clones.get(path);
    if (!clone) throw new Error(`There is no clone at ${path}.`);
    return clone;
  }

  private commit(): string {
    return `c${++this.commits}`.padEnd(40, '0');
  }
}

function isWithin(top: string, path: string): boolean {
  const rest = relative(top, path);
  return !rest.startsWith('..') && !isAbsolute(rest);
}
