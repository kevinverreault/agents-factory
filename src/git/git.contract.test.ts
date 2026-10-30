// Seam 3: the real git adapter on throwaway clones in a temp directory.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
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
      origins.set(path, origin);
      return path;
    },
    async advanceOrigin(clonePath, branch) {
      const origin = origins.get(clonePath)!;
      const tip = git(origin, 'rev-parse', branch);
      const next = git(origin, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'Move on');
      git(origin, 'update-ref', `refs/heads/${branch}`, next);
      return next;
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
