// Seam 3: the real git adapter on throwaway clones in a temp directory.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeGitContract, type CloneFixture } from './git-contract.ts';
import { gitCli } from './git.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Factory Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

async function fixture(): Promise<CloneFixture> {
  const root = mkdtempSync(join(tmpdir(), 'factory-git-'));
  const origins = new Map<string, string>();
  return {
    git: gitCli,
    root,
    async clone(name, { originUrl, defaultBranch }) {
      const path = join(root, name);
      mkdirSync(join(path, 'src'), { recursive: true });
      git(path, 'init', '--quiet');
      if (originUrl) git(path, 'remote', 'add', 'origin', originUrl);
      if (defaultBranch) {
        git(path, 'commit', '--quiet', '--allow-empty', '-m', 'Start');
        git(path, 'update-ref', `refs/remotes/origin/${defaultBranch}`, 'HEAD');
        git(path, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${defaultBranch}`);
      }
      return path;
    },
    async move(from, to) {
      renameSync(from, to);
    },
    async cloneWithOrigin(name, branch) {
      const origin = join(root, `${name}-origin.git`);
      const path = join(root, name);
      git(root, 'init', '--quiet', '--bare', `--initial-branch=${branch}`, origin);
      const seed = join(root, `${name}-seed`);
      git(root, 'init', '--quiet', `--initial-branch=${branch}`, seed);
      git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'Start');
      git(seed, 'push', '--quiet', origin, branch);
      git(root, 'clone', '--quiet', origin, path);
      // The operator's own identity, which the adapter's commits are made under.
      git(path, 'config', 'user.name', 'Factory Test');
      git(path, 'config', 'user.email', 'test@example.com');
      origins.set(path, origin);
      return path;
    },
    async advanceOrigin(clonePath, branch, files = {}) {
      const origin = origins.get(clonePath)!;
      // Committed from a scratch clone, so the clone itself fetches nothing yet.
      const scratch = mkdtempSync(join(root, 'scratch-'));
      git(root, 'clone', '--quiet', '--branch', branch, origin, scratch);
      // Bytes as given: no line-ending conversion on the way in.
      git(scratch, 'config', 'core.autocrlf', 'false');
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        writeFileSync(join(scratch, path), content);
      }
      git(scratch, 'add', '--all');
      git(scratch, 'commit', '--quiet', '--allow-empty', '-m', 'Move on');
      git(scratch, 'push', '--quiet', 'origin', branch);
      return git(scratch, 'rev-parse', 'HEAD');
    },
    async editFile(worktreePath, path) {
      const file = join(worktreePath, path);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, 'More.\n');
    },
    async commitAll(worktreePath) {
      git(worktreePath, 'add', '--all');
      git(worktreePath, 'commit', '--quiet', '-m', 'Commit it all');
    },
    async checkout(worktreePath, branch) {
      git(worktreePath, 'checkout', '--quiet', '-b', branch);
    },
    async setPushUrl(worktreePath, remote, url) {
      git(worktreePath, 'config', `remote.${remote}.pushurl`, url);
    },
    async dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describeGitContract('git', fixture);

test('git: a task worktree sets core.longpaths, and its branch tracks nothing', async () => {
  const { root, cloneWithOrigin, dispose } = await fixture();
  try {
    const clone = await cloneWithOrigin('widgets', 'main');
    const path = join(root, 'worktrees', 'T1');
    await gitCli.fetch(clone, 'main');
    await gitCli.addWorktree(clone, { path, branch: 'factory/T1-a', startPoint: 'origin/main' });

    expect(git(path, 'config', 'core.longpaths')).toBe('true');
    expect(() => git(path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
  } finally {
    await dispose();
  }
});

describe('git: the check after an AFK run', () => {
  // A task worktree on factory/T1-a, snapshotted as a run starting in it finds it.
  async function started(body: (run: { root: string; clone: string; path: string; check(branches?: string[]): Promise<string[]> }) => void) {
    const { root, cloneWithOrigin, dispose } = await fixture();
    try {
      const clone = await cloneWithOrigin('widgets', 'main');
      const path = join(root, 'worktrees', 'T1');
      await gitCli.fetch(clone, 'main');
      await gitCli.addWorktree(clone, { path, branch: 'factory/T1-a', startPoint: 'origin/main' });
      const before = await gitCli.snapshot(path);
      await body({ root, clone, path, check: (branches = []) => gitCli.violations(path, before, branches) });
    } finally {
      await dispose();
    }
  }

  test('a run that commits on its branch and fetches keeps every invariant', () =>
    started(async ({ path, check }) => {
      writeFileSync(join(path, 'login.ts'), 'export {};\n');
      git(path, 'add', '--all');
      git(path, 'commit', '--quiet', '-m', 'Fix the login bug');
      git(path, 'fetch', '--quiet', 'origin');

      expect(await check()).toEqual([]);
    }));

  test.each<[string, (run: { clone: string; path: string }) => void, string[]]>([
    [
      'switches branch',
      ({ path }) => git(path, 'checkout', '--quiet', '-b', 'spike'),
      ['The run left branch spike checked out instead of factory/T1-a.', 'The run added refs: refs/heads/spike.'],
    ],
    [
      'leaves the tree dirty',
      ({ path }) => {
        writeFileSync(join(path, 'notes.txt'), 'Later.\n');
      },
      ['The run left uncommitted changes: notes.txt.'],
    ],
    ['tags a commit', ({ path }) => git(path, 'tag', 'v1'), ['The run added refs: refs/tags/v1.']],
    [
      'adds a remote',
      ({ path }) => git(path, 'remote', 'add', 'fork', 'https://github.com/me/widgets.git'),
      ['The run added remotes: fork.', 'The run changed the git config.'],
    ],
    [
      'sets a pushurl',
      ({ path }) => git(path, 'config', 'remote.origin.pushurl', 'https://github.com/me/widgets.git'),
      ['The run changed the git config.', "A remote has a pushurl, which the run's push guard can't cover: remote.origin.pushurl."],
    ],
    [
      'adds a hook',
      ({ clone }) => {
        writeFileSync(join(clone, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
      },
      ['The run changed git hooks: pre-push.'],
    ],
  ])('a run that %s breaks the invariants, saying how', (_, act, reasons) =>
    started(async ({ clone, path, check }) => {
      act({ clone, path });

      expect(await check()).toEqual(reasons);
    }));

  test('a run that rewrites the branch below its start breaks the invariants', () =>
    started(async ({ path, check }) => {
      git(path, 'commit', '--quiet', '--amend', '--allow-empty', '-m', 'Rewritten');

      expect(await check()).toEqual([expect.stringMatching(/^The run rewrote factory\/T1-a: [0-9a-f]{7}, its tip before the run, is no longer in its history\.$/)]);
    }));

  test('a branch the factory cut for another task meanwhile is no ref the run added', () =>
    started(async ({ root, clone, check }) => {
      await gitCli.addWorktree(clone, { path: join(root, 'worktrees', 'T2'), branch: 'factory/T2-b', startPoint: 'origin/main' });

      expect(await check(['factory/T2-b'])).toEqual([]);
      expect(await check()).toEqual(['The run added refs: refs/heads/factory/T2-b.']);
    }));
});
