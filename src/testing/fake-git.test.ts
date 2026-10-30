import { join, resolve } from 'node:path';
import { describeGitContract } from '../git/git-contract.ts';
import { FakeGit } from './fake-git.ts';

describeGitContract('the fake git', async () => {
  const git = new FakeGit();
  const root = resolve('/fake-root');
  return {
    git,
    root,
    async clone(name, setup) {
      const path = join(root, name);
      git.addClone(path, setup);
      return path;
    },
    async move(from, to) {
      git.moveClone(from, to);
    },
    async cloneWithOrigin(name, branch) {
      const path = join(root, name);
      git.addClone(path, { originUrl: `https://github.com/acme/${name}.git`, defaultBranch: branch });
      return path;
    },
    async advanceOrigin(clonePath, branch) {
      return git.advanceOrigin(clonePath, branch);
    },
    async editFile(worktreePath, path) {
      git.editFile(worktreePath, path);
    },
    async commitAll(worktreePath) {
      git.commitAll(worktreePath);
    },
    async dispose() {},
  };
});
