import { relative, isAbsolute } from 'node:path';
import { GitError, type Clone, type DirectoryFile, type Git, type RunSnapshot, type Worktree, type WorktreeState } from '../git/git.ts';

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
  // What each worktree's uncommitted changes wrote, by path.
  private readonly edits = new Map<string, Map<string, string>>();
  // Each commit's files, by path from the top.
  private readonly trees = new Map<string, Map<string, string>>();
  // Each commit's parent, if it has one.
  private readonly parents = new Map<string, string>();
  private commitCount = 0;
  // What each worktree's AFK run broke, as the check after the run says it.
  private readonly broken = new Map<string, string[]>();
  // The worktrees checked after a run, each with the branches it was told to
  // ignore and the run's committer.
  readonly checked: { worktreePath: string; branches: string[]; committer: string }[] = [];
  // Each worktree's remotes with a `pushurl`, and theirs.
  private readonly pushUrls = new Map<string, Map<string, string>>();
  // The commits made through the port, in order.
  readonly commits: { worktreePath: string; paths: string[]; message: string }[] = [];

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
      const start = this.newCommit();
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
    const tip = this.newCommit(new Map([...(before ? this.trees.get(before)! : []), ...Object.entries(files)]));
    if (before) this.parents.set(tip, before);
    clone.origin.set(branch, tip);
    return tip;
  }

  // Pushes the clone's `branch` to origin under the same name, which moves
  // the clone's remote-tracking branch too, as git's push does.
  push(clonePath: string, branch: string): void {
    const clone = this.cloneAt(clonePath);
    clone.origin.set(branch, clone.branches.get(branch)!);
    clone.fetched.set(branch, clone.branches.get(branch)!);
  }

  // Origin's `base` moves to the clone's `branch`, as merging its PR would.
  merge(clonePath: string, branch: string, base: string): void {
    const clone = this.cloneAt(clonePath);
    clone.origin.set(base, clone.branches.get(branch)!);
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
    const head = startPoint.startsWith('origin/')
      ? clone.fetched.get(startPoint.slice('origin/'.length))
      : (clone.branches.get(startPoint) ?? (this.trees.has(startPoint) ? startPoint : undefined));
    if (!head) throw new GitError(`fatal: invalid reference: ${startPoint}`);
    clone.branches.set(branch, head);
    clone.worktrees.push({ path, branch, head, linkedTo: clonePath });
  }

  async worktrees(clonePath: string): Promise<Worktree[]> {
    return this.cloneAt(clonePath).worktrees.map(({ path, branch, head }) => ({ path, branch, head }));
  }

  async removeWorktree(clonePath: string, path: string): Promise<void> {
    const clone = this.cloneAt(clonePath);
    clone.worktrees = clone.worktrees.filter((worktree) => worktree.path !== path);
    this.changes.delete(path);
  }

  async deleteBranch(clonePath: string, branch: string): Promise<void> {
    const clone = this.cloneAt(clonePath);
    const worktree = clone.worktrees.find((worktree) => worktree.branch === branch);
    if (worktree) throw new GitError(`error: cannot delete branch '${branch}' used by worktree at '${worktree.path}'`);
    clone.branches.delete(branch);
  }

  async isMerged(clonePath: string, branch: string, into: string): Promise<boolean> {
    const clone = this.cloneAt(clonePath);
    const tip = clone.branches.get(branch);
    const base = into.startsWith('origin/') ? clone.fetched.get(into.slice('origin/'.length)) : clone.branches.get(into);
    if (!tip || !base) throw new GitError(`fatal: Not a valid commit name ${tip ? into : branch}`);
    for (let commit: string | undefined = base; commit; commit = this.parents.get(commit)) if (commit === tip) return true;
    return false;
  }

  async unpushed(clonePath: string, branch: string): Promise<string[]> {
    const clone = this.cloneAt(clonePath);
    const onOrigin = new Set<string>();
    for (const tip of clone.fetched.values()) {
      for (let commit: string | undefined = tip; commit && !onOrigin.has(commit); commit = this.parents.get(commit)) onOrigin.add(commit);
    }
    const unpushed: string[] = [];
    for (let commit = clone.branches.get(branch); commit && !onOrigin.has(commit); commit = this.parents.get(commit)) unpushed.push(commit);
    return unpushed;
  }

  async repairWorktree(clonePath: string, path: string): Promise<void> {
    const worktree = this.cloneAt(clonePath).worktrees.find((worktree) => worktree.path === path);
    if (!worktree) throw new GitError(`error: not a valid path: ${path}`);
    worktree.linkedTo = clonePath;
  }

  // Something changes `path` (relative, with `/`) in the worktree to
  // `content`, uncommitted.
  editFile(worktreePath: string, path: string, content = ''): void {
    const changes = this.changes.get(worktreePath) ?? new Set();
    this.changes.set(worktreePath, changes.add(path));
    const edits = this.edits.get(worktreePath) ?? new Map<string, string>();
    this.edits.set(worktreePath, edits.set(path, content));
  }

  // Everything changed in the worktree is committed, if anything is.
  commitAll(worktreePath: string): void {
    const changed = this.changes.get(worktreePath);
    this.changes.delete(worktreePath);
    if (changed?.size) this.advance(this.worktreeAt(worktreePath), [...changed]);
  }

  async uncommitted(worktreePath: string, paths: string[]): Promise<string[]> {
    return paths.filter((path) => this.changes.get(worktreePath)?.has(path));
  }

  // Something undoes the uncommitted change to `path` in the worktree.
  discard(worktreePath: string, path: string): void {
    this.changes.get(worktreePath)?.delete(path);
    this.edits.get(worktreePath)?.delete(path);
  }

  // Something checks `branch` out in the worktree instead of its own.
  checkout(worktreePath: string, branch: string): void {
    this.worktreeAt(worktreePath).branch = branch;
  }

  // Something sets the remote's `pushurl` in the worktree, or unsets it (null).
  setPushUrl(worktreePath: string, remote: string, url: string | null): void {
    const urls = this.pushUrls.get(worktreePath) ?? new Map<string, string>();
    if (url === null) urls.delete(remote);
    else urls.set(remote, url);
    this.pushUrls.set(worktreePath, urls);
  }

  async worktreeState(worktreePath: string): Promise<WorktreeState> {
    const { branch } = this.worktreeAt(worktreePath);
    const pushUrls = [...(this.pushUrls.get(worktreePath)?.keys() ?? [])].map((remote) => `remote.${remote}.pushurl`);
    return { branch, uncommitted: [...(this.changes.get(worktreePath) ?? [])], pushUrls };
  }

  async commit(worktreePath: string, paths: string[], message: string): Promise<string> {
    const worktree = this.worktreeAt(worktreePath);
    if (!paths.some((path) => this.changes.get(worktreePath)?.has(path))) throw new GitError('nothing to commit');
    for (const path of paths) this.changes.get(worktreePath)?.delete(path);
    const commit = this.advance(worktree, paths);
    this.commits.push({ worktreePath, paths, message });
    return commit;
  }

  // A new commit on the worktree's branch, with what `paths` were edited to.
  private advance(worktree: FakeWorktree, paths: string[]): string {
    const edits = this.edits.get(worktree.path);
    const tree = new Map(this.trees.get(worktree.head));
    for (const path of paths) {
      tree.set(path, edits?.get(path) ?? '');
      edits?.delete(path);
    }
    const commit = this.newCommit(tree);
    this.parents.set(commit, worktree.head);
    worktree.head = commit;
    this.cloneAt(worktree.linkedTo).branches.set(worktree.branch, commit);
    return commit;
  }

  async commitsSince(worktreePath: string, base: string): Promise<string[]> {
    const since: string[] = [];
    for (let commit: string | undefined = this.worktreeAt(worktreePath).head; commit && commit !== base; commit = this.parents.get(commit)) {
      since.unshift(commit);
    }
    return since;
  }

  // The run in the worktree breaks an invariant, which the check after it
  // reports with `reason`.
  breakInvariant(worktreePath: string, reason: string): void {
    this.broken.set(worktreePath, [...(this.broken.get(worktreePath) ?? []), reason]);
  }

  async snapshot(worktreePath: string): Promise<RunSnapshot> {
    const worktree = this.worktreeAt(worktreePath);
    return { branch: worktree.branch, head: worktree.head, refs: [], remotes: [], config: [], hooks: {} };
  }

  async violations(worktreePath: string, _before: RunSnapshot, branches: string[], committer: string): Promise<string[]> {
    this.worktreeAt(worktreePath);
    this.checked.push({ worktreePath, branches, committer });
    return this.broken.get(worktreePath) ?? [];
  }

  private worktreeAt(path: string): FakeWorktree {
    const worktree = [...this.clones.values()].flatMap((clone) => clone.worktrees).find((worktree) => worktree.path === path);
    if (!worktree) throw new GitError(`fatal: not a git repository: ${path}`);
    return worktree;
  }

  private cloneAt(path: string): FakeClone {
    const clone = this.clones.get(path);
    if (!clone) throw new Error(`There is no clone at ${path}.`);
    return clone;
  }

  async readDirectory(clonePath: string, ref: string, dir: string): Promise<{ commit: string; files: DirectoryFile[] }> {
    return this.readTree(clonePath, ref, (path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'));
  }

  async readFiles(clonePath: string, ref: string, paths: string[]): Promise<{ commit: string; files: DirectoryFile[] }> {
    return this.readTree(clonePath, ref, (path) => paths.includes(path));
  }

  // The files at `ref` whose paths `wanted`, in path order.
  private readTree(clonePath: string, ref: string, wanted: (path: string) => boolean): { commit: string; files: DirectoryFile[] } {
    const clone = this.cloneAt(clonePath);
    // Only origin's branches are read: the factory reads presets and the
    // skill set's setup nowhere else.
    const commit = ref.startsWith('origin/') ? clone.fetched.get(ref.slice('origin/'.length)) : undefined;
    if (!commit) throw new GitError(`${ref} names no commit.`);
    const files = [...this.trees.get(commit)!]
      .filter(([path]) => wanted(path))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => ({ path, content }));
    return { commit, files };
  }

  private newCommit(files = new Map<string, string>()): string {
    const commit = `c${++this.commitCount}`.padEnd(40, '0');
    this.trees.set(commit, files);
    return commit;
  }
}

function isWithin(top: string, path: string): boolean {
  const rest = relative(top, path);
  return !rest.startsWith('..') && !isAbsolute(rest);
}
