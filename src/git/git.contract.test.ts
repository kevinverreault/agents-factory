// Seam 3: the real git adapter on throwaway clones in a temp directory.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeGitContract } from './git-contract.ts';
import { gitCli } from './git.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Factory Test', '-c', 'user.email=test@example.com', ...args], { cwd, windowsHide: true });
}

describeGitContract('git', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-git-'));
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
    async dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
});
