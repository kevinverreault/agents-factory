import { join, resolve } from 'node:path';
import { describeGitContract } from '../git/git-contract.ts';
import { FAKE_OPERATOR, FakeGit } from './fake-git.ts';

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
    async advanceOrigin(clonePath, branch, files) {
      return git.advanceOrigin(clonePath, branch, files);
    },
    async editFile(worktreePath, path) {
      git.editFile(worktreePath, path);
    },
    async commitAll(worktreePath) {
      git.commitAll(worktreePath);
    },
    async writeFile(worktreePath, path, content) {
      if (content === null) git.deleteFile(worktreePath, path);
      else git.editFile(worktreePath, path, content);
    },
    async commitAs(worktreePath, email) {
      git.commitAll(worktreePath, { author: email });
    },
    async checkout(worktreePath, branch) {
      git.checkout(worktreePath, branch);
    },
    async setPushUrl(worktreePath, remote, url) {
      git.setPushUrl(worktreePath, remote, url);
    },
    async push(clonePath, branch) {
      git.push(clonePath, branch);
    },
    async merge(clonePath, branch, base) {
      git.mergeIntoOrigin(clonePath, branch, base);
    },
    identity: FAKE_OPERATOR,
    async dispose() {},
  };
});
