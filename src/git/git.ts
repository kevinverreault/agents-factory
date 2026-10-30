// The Git port: what the daemon reads from the operator's clones. Tests drive
// a fake; `gitCli` runs the real `git`.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export type Clone = {
  // The clone's top level, absolute: its main worktree, even when the path
  // inspected is in one of its linked worktrees.
  path: string;
  // `origin`'s URL, or null when the clone has no `origin`.
  originUrl: string | null;
  // The branch `origin/HEAD` points at, or null when it isn't set.
  defaultBranch: string | null;
};

// A worktree linked to a clone (its main worktree aside).
export type Worktree = { path: string; branch: string; head: string };

export interface Git {
  // The clone holding `path` (its top level, anywhere inside it or inside one
  // of its worktrees), or null when `path` isn't inside a clone or is in a
  // worktree that lost track of its clone.
  inspectClone(path: string): Promise<Clone | null>;
  // Brings `origin/<branch>` up to date with origin. Throws a `GitError`
  // when origin can't be reached or has no such branch.
  fetch(clonePath: string, branch: string): Promise<void>;
  // Cuts `branch` from `startPoint` and checks it out in a new worktree at
  // `path`. Throws a `GitError` when the branch exists or `path` is taken.
  addWorktree(clonePath: string, worktree: { path: string; branch: string; startPoint: string }): Promise<void>;
  worktrees(clonePath: string): Promise<Worktree[]>;
  // Which of `paths` (relative to the worktree, with `/`) have changes not
  // yet committed there, untracked files included.
  uncommitted(worktreePath: string, paths: string[]): Promise<string[]>;
  // Points the worktree at `path` back at its clone, now at `clonePath`, after
  // the clone moved (ADR 0010). Throws a `GitError` when `path` is no
  // worktree of the clone.
  repairWorktree(clonePath: string, path: string): Promise<void>;
}

export class GitError extends Error {}

export const gitCli: Git = {
  async inspectClone(path) {
    // The listing starts with the main worktree, wherever it is run from.
    const main = (await git(path, 'worktree', 'list', '--porcelain'))?.match(/^worktree ([^\r\n]+)/m)?.[1];
    if (!main) return null;
    const top = resolve(main);
    const head = await git(top, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
    return {
      path: top,
      originUrl: await git(top, 'remote', 'get-url', 'origin'),
      defaultBranch: head?.startsWith('origin/') ? head.slice('origin/'.length) : null,
    };
  },

  async fetch(clonePath, branch) {
    await run(clonePath, 'fetch', '--quiet', 'origin', branch);
  },

  async addWorktree(clonePath, { path, branch, startPoint }) {
    // Deep `node_modules` trees pass Windows' path limit (ADR 0010). Without
    // `extensions.worktreeConfig` a worktree shares its clone's config, so the
    // setting goes there.
    await run(clonePath, 'config', 'core.longpaths', 'true');
    // No upstream: the task branch is never pushed to its base branch.
    await run(clonePath, 'worktree', 'add', '--quiet', '--no-track', '-b', branch, path, startPoint);
  },

  async worktrees(clonePath) {
    const listing = await run(clonePath, 'worktree', 'list', '--porcelain');
    // The first entry is the clone's own working tree.
    return listing
      .split(/\r?\n\r?\n/)
      .slice(1)
      .flatMap((entry) => {
        const fields = new Map(entry.split(/\r?\n/).map((line) => [line.split(' ', 1)[0], line.slice(line.indexOf(' ') + 1)]));
        const path = fields.get('worktree');
        const head = fields.get('HEAD');
        // A detached worktree has no `branch` line.
        const branch = fields.get('branch')?.replace(/^refs\/heads\//, '');
        return path && head && branch ? [{ path: resolve(path), branch, head }] : [];
      });
  },

  async uncommitted(worktreePath, paths) {
    if (paths.length === 0) return [];
    // NUL-separated, so paths come back unquoted: `XY path`, and after a
    // rename's or a copy's entry, its old path on its own, changed too.
    const listing = await output(worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths);
    const fields = listing.split('\0');
    const changed = new Set<string>();
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i]!;
      if (entry.length < 4) continue;
      changed.add(entry.slice(3));
      if (entry[0] === 'R' || entry[0] === 'C') changed.add(fields[++i] ?? '');
    }
    return paths.filter((path) => changed.has(path));
  },

  async repairWorktree(clonePath, path) {
    await run(clonePath, 'worktree', 'repair', path);
  },
};

// The command's trimmed output, or null when it fails.
function git(cwd: string, ...args: string[]): Promise<string | null> {
  return run(cwd, ...args).catch(() => null);
}

// The command's trimmed output. Throws a `GitError` with git's own message
// when it fails.
function run(cwd: string, ...args: string[]): Promise<string> {
  return output(cwd, ...args).then((stdout) => stdout.trim());
}

// The command's output as git wrote it.
function output(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((done, fail) =>
    execFile('git', ['-C', cwd, ...args], { windowsHide: true }, (error, stdout, stderr) =>
      error ? fail(new GitError(stderr.trim() || error.message)) : done(stdout),
    ),
  );
}
