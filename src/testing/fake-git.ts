import { relative, isAbsolute } from 'node:path';
import { GitError, type Clone, type DirectoryFile, type Git, type Worktree } from '../git/git.ts';

type CloneSetup = { originUrl?: string | null; defaultBranch?: string | null };

// A worktree, with the clone path it was last linked to: moving the clone
// leaves it pointing at the old one until it is repaired.
type FakeWorktree = Worktree & { linkedTo: string };

type FakeClone = Clone & {
  // Branch tips on origin, and what the clone last fetched of them.
  origin: Map<string, string>;
  fetched: Map<string, string>;
  branches: Map<string, string>;
  worktrees: FakeWorktree[];
  // Set while origin can't be reached, with what git would say.
  unreachable: string | null;
};

// Clones that exist only in memory: a test adds, moves and removes them, and
// moves their origin on.
export class FakeGit implements Git {
  private readonly clones = new Map<string, FakeClone>();
  // Each worktree's paths with changes not yet committed.
  private readonly changes = new Map<string, Set<string>>();
  // Each commit's files, by path from the top.
  private readonly trees = new Map<string, Map<string, string>>();
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

  // Adds a commit to `branch` on origin, which the clone hasn't fetched yet,
  // writing `files` (by path, with `/`).
  advanceOrigin(clonePath: string, branch: string, files: Record<string, string> = {}): string {
    const clone = this.cloneAt(clonePath);
    const before = clone.origin.get(branch);
    const tip = this.commit(new Map([...(before ? this.trees.get(before)! : []), ...Object.entries(files)]));
    clone.origin.set(branch, tip);
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
    for (const { path: top, originUrl, defaultBranch, worktrees } of this.clones.values()) {
      const worktree = worktrees.find((worktree) => isWithin(worktree.path, path));
      if (worktree) return worktree.linkedTo === top ? { path: top, originUrl, defaultBranch } : null;
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
    clone.worktrees.push({ path, branch, head, linkedTo: clonePath });
  }

  async worktrees(clonePath: string): Promise<Worktree[]> {
    return this.cloneAt(clonePath).worktrees.map(({ path, branch, head }) => ({ path, branch, head }));
  }

  async repairWorktree(clonePath: string, path: string): Promise<void> {
    const worktree = this.cloneAt(clonePath).worktrees.find((worktree) => worktree.path === path);
    if (!worktree) throw new GitError(`error: not a valid path: ${path}`);
    worktree.linkedTo = clonePath;
  }

  // Something changes `path` (relative, with `/`) in the worktree, uncommitted.
  editFile(worktreePath: string, path: string): void {
    const changes = this.changes.get(worktreePath) ?? new Set();
    this.changes.set(worktreePath, changes.add(path));
  }

  // Everything changed in the worktree is committed.
  commitAll(worktreePath: string): void {
    this.changes.delete(worktreePath);
  }

  async uncommitted(worktreePath: string, paths: string[]): Promise<string[]> {
    return paths.filter((path) => this.changes.get(worktreePath)?.has(path));
  }

  private cloneAt(path: string): FakeClone {
    const clone = this.clones.get(path);
    if (!clone) throw new Error(`There is no clone at ${path}.`);
    return clone;
  }

  async readDirectory(clonePath: string, ref: string, dir: string): Promise<{ commit: string; files: DirectoryFile[] }> {
    const clone = this.cloneAt(clonePath);
    // Only origin's branches are read: the factory reads presets nowhere else.
    const commit = ref.startsWith('origin/') ? clone.fetched.get(ref.slice('origin/'.length)) : undefined;
    if (!commit) throw new GitError(`${ref} names no commit.`);
    const files = [...this.trees.get(commit)!]
      .filter(([path]) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
      .map(([path, content]) => ({ path, content }));
    return { commit, files };
  }

  private commit(files = new Map<string, string>()): string {
    const commit = `c${++this.commits}`.padEnd(40, '0');
    this.trees.set(commit, files);
    return commit;
  }
}

function isWithin(top: string, path: string): boolean {
  const rest = relative(top, path);
  return !rest.startsWith('..') && !isAbsolute(rest);
}
