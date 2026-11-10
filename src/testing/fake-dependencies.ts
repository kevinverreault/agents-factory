import { DependenciesError, type Dependencies } from '../dependencies/dependencies.ts';

// Dependencies that install in memory: each worktree with a lockfile, as a
// test gives it one, installs once, unless the test makes installs fail.
export class FakeDependencies implements Dependencies {
  // Each install made, by worktree, in order.
  readonly installs: string[] = [];
  private readonly lockfiles = new Set<string>();
  private readonly installed = new Set<string>();
  private failure: string | null = null;
  private held: Promise<void> = Promise.resolve();

  // Installs wait until the returned function is called.
  holdInstalls(): () => void {
    let release!: () => void;
    this.held = new Promise((resolve) => (release = resolve));
    return release;
  }

  // The worktree at `path` has a lockfile, its dependencies not installed.
  addLockfile(path: string): void {
    this.lockfiles.add(path);
    this.installed.delete(path);
  }

  // Installs fail with `reason` from now on, or succeed again with null.
  failInstalls(reason: string | null): void {
    this.failure = reason;
  }

  async install(worktree: string): Promise<string | null> {
    if (!this.lockfiles.has(worktree) || this.installed.has(worktree)) return null;
    this.installs.push(worktree);
    await this.held;
    if (this.failure) throw new DependenciesError(this.failure);
    this.installed.add(worktree);
    return 'npm ci';
  }
}
