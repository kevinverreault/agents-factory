import { describeGitHubContract, type GitHubFixture } from '../github/github-contract.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeGit } from './fake-git.ts';
import { FakeGitHub } from './fake-github.ts';

describeGitHubContract('the fake GitHub', () => fixture({ draftsOffered: true }));
describeGitHubContract('the fake GitHub, offering no draft PRs', () => fixture({ draftsOffered: false }));

async function fixture({ draftsOffered }: { draftsOffered: boolean }): Promise<GitHubFixture> {
  const clock = new FakeClock();
  const git = new FakeGit();
  const github = new FakeGitHub(clock, git);
  const app = await github.createApp(github.manifestCode());
  const path = '/clones/widgets';
  git.addClone(path, { originUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main' });
  github.install('acme/widgets');
  github.addIssue('acme/widgets#1');
  if (!draftsOffered) github.offerNoDrafts('acme/widgets');
  return {
    github,
    app,
    installedRepo: 'acme/widgets',
    uninstalledRepo: 'octocat/Hello-World',
    openIssue: 'acme/widgets#1',
    reopenByHand: async (ref) => github.reopenIssue(ref),
    now: () => clock.now(),
    clone: {
      path,
      async commitOn(branch, files) {
        const worktree = `/worktrees/${branch}`;
        await git.addWorktree(path, { path: worktree, branch, startPoint: 'origin/main' });
        for (const [file, content] of Object.entries(files)) git.editFile(worktree, file, content);
        git.commitAll(worktree);
        return (await git.snapshot(worktree)).head;
      },
      remoteTip: async (branch) => git.originTip(path, branch),
      pushByHand: async (branch) => git.push(path, branch),
    },
    operator: github.operator,
    baseBranch: 'main',
    draftsOffered,
    async pullRequest(number) {
      const { draft, head, base, title, body, assignees } = github.pullRequests.find((pr) => pr.number === number)!;
      return { draft, head, base, title, body, assignees };
    },
  };
}
