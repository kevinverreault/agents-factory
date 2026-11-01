// Seam 3: the real git adapter on throwaway clones in a temp directory.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FACTORY_IDENTITY, prepareRunGit } from '../guards/run-git.ts';
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
    async push(clonePath, branch) {
      git(clonePath, 'push', '--quiet', 'origin', branch);
    },
    async merge(clonePath, branch, base) {
      git(clonePath, 'push', '--quiet', 'origin', `${branch}:${base}`);
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
  type Started = { root: string; clone: string; path: string; inRun(...args: string[]): string; check(branches?: string[]): Promise<string[]> };

  // A task worktree on factory/T1-a, snapshotted as a run starting in it
  // finds it. `inRun` runs git as the run does, in its cleaned environment.
  async function started(body: (run: Started) => void) {
    const { root, cloneWithOrigin, dispose } = await fixture();
    try {
      const clone = await cloneWithOrigin('widgets', 'main');
      const path = join(root, 'worktrees', 'T1');
      await gitCli.fetch(clone, 'main');
      await gitCli.addWorktree(clone, { path, branch: 'factory/T1-a', startPoint: 'origin/main' });
      const before = await gitCli.snapshot(path);
      const env = { ...process.env, ...prepareRunGit(join(root, 'run'), FACTORY_IDENTITY, { task: 'T1', run: 'R1', model: 'sonnet' }) };
      const inRun = (...args: string[]) => execFileSync('git', args, { cwd: path, env, encoding: 'utf8', windowsHide: true }).trim();
      await body({ root, clone, path, inRun, check: (branches = []) => gitCli.violations(path, before, branches, FACTORY_IDENTITY.email) });
    } finally {
      await dispose();
    }
  }

  test('a run that commits on its branch and fetches keeps every invariant', () =>
    started(async ({ path, inRun, check }) => {
      writeFileSync(join(path, 'login.ts'), 'export {};\n');
      inRun('add', '--all');
      inRun('commit', '--quiet', '-m', 'Fix the login bug');
      inRun('fetch', '--quiet', 'origin');

      expect(await check()).toEqual([]);
    }));

  test.each<[string, (run: Started) => void, string[]]>([
    [
      'switches branch',
      ({ inRun }) => inRun('checkout', '--quiet', '-b', 'spike'),
      ['The run left branch spike checked out instead of factory/T1-a.', 'The run added refs: refs/heads/spike.'],
    ],
    [
      'leaves the tree dirty',
      ({ path }) => {
        writeFileSync(join(path, 'notes.txt'), 'Later.\n');
      },
      ['The run left uncommitted changes: notes.txt.'],
    ],
    ['tags a commit', ({ inRun }) => inRun('tag', 'v1'), ['The run added refs: refs/tags/v1.']],
    ['makes a branch of another commit', ({ inRun }) => inRun('branch', 'spike', 'origin/main'), ['The run added refs: refs/heads/spike.']],
    [
      'adds a remote',
      ({ inRun }) => inRun('remote', 'add', 'fork', 'https://github.com/me/widgets.git'),
      ['The run added remotes: fork.', 'The run changed the git config.'],
    ],
    [
      'sets a pushurl',
      ({ inRun }) => inRun('config', 'remote.origin.pushurl', 'https://github.com/me/widgets.git'),
      ['The run changed the git config.', "A remote has a pushurl, which the run's push guard can't cover: remote.origin.pushurl."],
    ],
    [
      'points its branch’s pushes elsewhere',
      ({ inRun }) => inRun('config', 'branch.factory/T1-a.pushRemote', 'fork'),
      ['The run changed the git config.'],
    ],
    [
      'adds a hook',
      ({ clone }) => {
        writeFileSync(join(clone, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
      },
      ['The run changed git hooks: pre-push.'],
    ],
  ])('a run that %s breaks the invariants, saying how', (_, act, reasons) =>
    started(async (run) => {
      act(run);

      expect(await run.check()).toEqual(reasons);
    }));

  test('a run that rewrites the branch below its start breaks the invariants', () =>
    started(async ({ inRun, check }) => {
      inRun('commit', '--quiet', '--amend', '--allow-empty', '-m', 'Rewritten');

      expect(await check()).toEqual([expect.stringMatching(/^The run rewrote factory\/T1-a: [0-9a-f]{7}, its tip before the run, is no longer in its history\.$/)]);
    }));

  // Unlogged, the branch could be the run's but for the factory's word.
  test('a branch the factory cut for another task meanwhile, even unlogged, is no ref the run added', () =>
    started(async ({ root, clone, check }) => {
      git(clone, '-c', 'core.logAllRefUpdates=false', 'worktree', 'add', '--quiet', '-b', 'factory/T2-b', join(root, 'worktrees', 'T2'), 'origin/main');

      expect(await check(['factory/T2-b'])).toEqual([]);
      expect(await check()).toEqual(['The run added refs: refs/heads/factory/T2-b.']);
    }));

  // The task worktree shares its clone with the operator's own work (ADR 0010).
  test('branches the operator makes meanwhile, and their tools’ branch settings, are not the run’s doing', () =>
    started(async ({ root, clone, check }) => {
      git(clone, 'worktree', 'add', '--quiet', '-b', 'worktree-agent-a1', join(root, 'agent'), 'origin/main');
      git(join(root, 'agent'), 'checkout', '--quiet', '-b', 'claude/issue-88');
      git(clone, 'config', 'branch.claude/issue-88.remote', 'origin');
      git(clone, 'config', 'branch.claude/issue-88.merge', 'refs/heads/claude/issue-88');
      git(clone, 'config', 'branch.factory/T1-a.vscode-merge-base', 'origin/main');

      expect(await check()).toEqual([]);
    }));
});
