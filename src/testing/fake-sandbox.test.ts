import { join, resolve } from 'node:path';
import { describeSandboxContract } from '../sandbox/sandbox-contract.ts';
import { FakeGit } from './fake-git.ts';
import { FakeSandbox } from './fake-sandbox.ts';

describeSandboxContract('the fake sandbox', async () => {
  const git = new FakeGit();
  const sandbox = new FakeSandbox(git);
  let edits = 0;
  const commit = (worktree: string) => {
    git.editFile(worktree, `file-${++edits}.txt`, `${edits}`);
    git.commitAll(worktree);
    return git.snapshot(worktree).then(({ head }) => head);
  };
  return {
    sandbox,
    async task(taskId) {
      const clonePath = resolve(`/host/${taskId}`);
      const worktree = resolve(`/host/${taskId}-worktree`);
      const branch = `factory/${taskId}`;
      git.addClone(clonePath, { originUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main' });
      await git.addWorktree(clonePath, { path: worktree, branch, startPoint: 'main' });
      const spec = { taskId, clonePath, branch, branches: [], plugin: null, runDir: join(worktree, '..', 'run'), sessionsDir: join(worktree, '..', 'sessions'), egress: ['example.com'] };
      return { spec, worktree };
    },
    commitOnHost: commit,
    async branchOnHost(spec, branch) {
      const path = resolve(`/host/${branch.replaceAll('/', '-')}`);
      await git.addWorktree(spec.clonePath, { path, branch, startPoint: spec.branch });
      return commit(path);
    },
    commitInContainer: (container) => commit(container.workdir),
    async fetchOnHost(spec, branch) {
      const path = resolve(`/host/${spec.taskId}-fetched-${branch}`);
      await git.addWorktree(spec.clonePath, { path, branch: `fetched/${branch}`, startPoint: `origin/${branch}` });
      const tip = await commit(path);
      git.setFetched(spec.clonePath, branch, tip);
      return tip;
    },
    async containerFetchedTip(container, branch) {
      return git.fetchedTip(sandbox.clonePathOf(container.taskId), branch)!;
    },
    async hostTip(spec, branch) {
      return git.branchTip(spec.clonePath, branch)!;
    },
    async containerTip(container, branch) {
      return git.branchTip(sandbox.clonePathOf(container.taskId), branch)!;
    },
    async reach(container, host) {
      return sandbox.request(container.taskId, host);
    },
    allowedHost: 'example.com',
    deniedHost: 'example.org',
    async dispose() {},
  };
});
