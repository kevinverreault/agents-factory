import { describe, expect, test } from 'vitest';
import { APP_PERMISSIONS } from '../github/github.ts';
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
  const statuses = new Map<string, Map<string, string>>();
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
    // Each context's latest status counts, as on GitHub.
    async setStatus(commit, context, state) {
      const set = (statuses.get(commit) ?? new Map<string, string>()).set(context, state);
      statuses.set(commit, set);
      const states = [...set.values()];
      github.setCommitChecks(commit, states.includes('failure') ? 'red' : states.includes('pending') ? 'pending' : 'green');
    },
    draftsOffered,
    async pullRequest(number) {
      const { draft, head, base, title, body, assignees } = github.pullRequests.find((pr) => pr.number === number)!;
      return { draft, head, base, title, body, assignees };
    },
  };
}

describe('the fake GitHub’s installations', () => {
  test('grant all the App asks for by default, or fewer until the operator approves the rest, and mint tokens only within the grant', async () => {
    const github = new FakeGitHub(new FakeClock(), new FakeGit());
    const app = await github.createApp(github.manifestCode());
    github.install('acme/widgets', { contents: 'write', metadata: 'read' });

    expect(await github.installation(app, 'acme/widgets')).toEqual({ permissions: { contents: 'write', metadata: 'read' }, settingsUrl: 'https://github.com/settings/installations/1' });
    await expect(github.mintToken(app, 'acme/widgets', { checks: 'read' })).rejects.toThrow(/not granted to this installation/);
    await expect(github.mintToken(app, 'acme/widgets', { contents: 'read' })).resolves.toMatchObject({ token: expect.stringMatching(/^ghs_/) });

    github.approvePermissions('acme/widgets');
    expect(await github.installation(app, 'acme/widgets')).toMatchObject({ permissions: APP_PERMISSIONS });
    expect(APP_PERMISSIONS).toMatchObject({ checks: 'read', statuses: 'read' });
  });
});
