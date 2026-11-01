// The Git port: what the daemon reads from the operator's clones. Tests drive
// a fake; `gitCli` runs the real `git`.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  // The files directly in `dir` (relative, with `/`) as committed at `ref`
  // (such as `origin/main`), by their path from the top, with the commit
  // `ref` points at. A directory the commit lacks holds none. Throws a
  // `GitError` when `ref` names no commit.
  readDirectory(clonePath: string, ref: string, dir: string): Promise<{ commit: string; files: DirectoryFile[] }>;
  // How the worktree stands for a handoff.
  worktreeState(worktreePath: string): Promise<WorktreeState>;
  // Commits exactly `paths` (relative, with `/`), new files included, under
  // the worktree's own git identity, and returns the commit.
  // Changes to other paths stay uncommitted.
  commit(worktreePath: string, paths: string[], message: string): Promise<string>;
  // The worktree as an AFK run starting in it finds it.
  snapshot(worktreePath: string): Promise<RunSnapshot>;
  // How the worktree breaks the invariants of its snapshot from before the
  // run, one reason each, or none: the branch is still checked out, its old
  // tip is in its history, the tree is clean, no ref, remote, config or hook
  // changed, and no remote has a `pushurl`, which `pushInsteadOf` would
  // leave alone. Remote-tracking refs, which fetches add, and the `branches`
  // the factory cut for other tasks meanwhile don't count as added refs.
  violations(worktreePath: string, before: RunSnapshot, branches: string[]): Promise<string[]>;
}

export type DirectoryFile = { path: string; content: string };

export type WorktreeState = {
  // The branch checked out, or null when HEAD is detached.
  branch: string | null;
  // Every path with changes not yet committed, untracked files included.
  uncommitted: string[];
  // The `remote.<name>.pushurl` settings there are, by name.
  pushUrls: string[];
};

// What an AFK run must leave as it found it (ADR 0007), read before it starts.
export type RunSnapshot = {
  branch: string;
  head: string;
  refs: string[];
  remotes: string[];
  // The clone's config, and the worktree's own when it has one.
  config: string;
  // Each hook's name, with a hash of its content.
  hooks: Record<string, string>;
};

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
    const changed = new Set(changedIn(await output(worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths)));
    return paths.filter((path) => changed.has(path));
  },

  async worktreeState(worktreePath) {
    const [branch, listing, pushUrls] = await Promise.all([
      git(worktreePath, 'symbolic-ref', '--quiet', '--short', 'HEAD'),
      output(worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
      git(worktreePath, 'config', '--name-only', '--get-regexp', '^remote\\..*\\.pushurl$'),
    ]);
    return { branch, uncommitted: changedIn(listing), pushUrls: lines(pushUrls ?? '') };
  },

  async commit(worktreePath, paths, message) {
    // Staged first, so new files are known; `--only` leaves whatever else is staged out.
    await run(worktreePath, 'add', '--all', '--', ...paths);
    await run(worktreePath, 'commit', '--quiet', '--only', '--message', message, '--', ...paths);
    return run(worktreePath, 'rev-parse', 'HEAD');
  },

  async repairWorktree(clonePath, path) {
    await run(clonePath, 'worktree', 'repair', path);
  },

  async readDirectory(clonePath, ref, dir) {
    const commit = await run(clonePath, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`).catch(() => {
      throw new GitError(`${ref} names no commit.`);
    });
    // `<mode> <type> <hash>\t<path>` per entry, NUL-separated and unquoted.
    const listing = await output(clonePath, 'ls-tree', '-z', commit, '--', `${dir}/`);
    const files: DirectoryFile[] = [];
    for (const entry of listing.split('\0')) {
      const [, type, hash, path] = /^\d+ (\w+) ([0-9a-f]+)\t(.*)$/s.exec(entry) ?? [];
      if (type === 'blob') files.push({ path: path!, content: await output(clonePath, 'cat-file', 'blob', hash!) });
    }
    return { commit, files };
  },

  async snapshot(worktreePath) {
    const [branch, head, refs, remotes, gitDir, commonDir] = await Promise.all([
      git(worktreePath, 'symbolic-ref', '--quiet', '--short', 'HEAD'),
      run(worktreePath, 'rev-parse', 'HEAD'),
      run(worktreePath, 'for-each-ref', '--format=%(refname)'),
      run(worktreePath, 'remote'),
      run(worktreePath, 'rev-parse', '--path-format=absolute', '--git-dir'),
      run(worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    ]);
    return {
      branch: branch ?? '',
      head,
      refs: lines(refs),
      remotes: lines(remotes),
      config: [join(commonDir, 'config'), join(gitDir, 'config.worktree')].map(readOrEmpty).join('\n'),
      hooks: hooksIn(join(commonDir, 'hooks')),
    };
  },

  async violations(worktreePath, before, branches) {
    const after = await gitCli.snapshot(worktreePath);
    const found: string[] = [];
    if (after.branch !== before.branch) {
      found.push(`The run left ${after.branch ? `branch ${after.branch}` : 'a detached HEAD'} checked out instead of ${before.branch}.`);
    }
    // A run that started detached is held to its HEAD.
    const tip = await git(worktreePath, 'rev-parse', '--verify', '--quiet', before.branch ? `refs/heads/${before.branch}` : 'HEAD');
    if (!tip || (await git(worktreePath, 'merge-base', '--is-ancestor', before.head, tip)) === null) {
      found.push(`The run rewrote ${before.branch || 'HEAD'}: ${before.head.slice(0, 7)}, its tip before the run, is no longer in its history.`);
    }
    const dirty = lines(await output(worktreePath, 'status', '--porcelain=v1', '--untracked-files=all')).map((line) => line.slice(3));
    if (dirty.length) found.push(`The run left uncommitted changes: ${listed(dirty)}.`);
    const known = new Set([...before.refs, ...branches.map((branch) => `refs/heads/${branch}`)]);
    const refs = after.refs.filter((ref) => !known.has(ref) && !ref.startsWith('refs/remotes/'));
    if (refs.length) found.push(`The run added refs: ${listed(refs)}.`);
    const remotes = after.remotes.filter((remote) => !before.remotes.includes(remote));
    if (remotes.length) found.push(`The run added remotes: ${listed(remotes)}.`);
    if (after.config !== before.config) found.push('The run changed the git config.');
    const pushUrls = lines((await git(worktreePath, 'config', '--name-only', '--get-regexp', '^remote\\..*\\.pushurl$')) ?? '');
    if (pushUrls.length) found.push(`A remote has a pushurl, which the run's push guard can't cover: ${listed(pushUrls)}.`);
    const hooks = [...new Set([...Object.keys(before.hooks), ...Object.keys(after.hooks)])].filter((hook) => before.hooks[hook] !== after.hooks[hook]);
    if (hooks.length) found.push(`The run changed git hooks: ${listed(hooks.sort())}.`);
    return found;
  },
};

// The paths a `status --porcelain=v1 -z` listing names: NUL-separated, so
// unquoted, as `XY path`, and after a rename's or a copy's entry, its old
// path on its own, changed too.
function changedIn(listing: string): string[] {
  const fields = listing.split('\0');
  const changed: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    changed.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') changed.push(fields[++i] ?? '');
  }
  return changed;
}

// The output's non-empty lines.
function lines(text: string): string[] {
  return text.split(/\r?\n/).filter(Boolean);
}

// The first few, and how many more.
function listed(items: string[]): string {
  return items.length > 5 ? `${items.slice(0, 5).join(', ')} and ${items.length - 5} more` : items.join(', ');
}

// The file's content, or nothing when there is no such file.
function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// Each file in the hooks directory, with a hash of its content.
function hooksIn(dir: string): Record<string, string> {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return {};
  }
  return Object.fromEntries(names.map((name) => [name, createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')]));
}

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
