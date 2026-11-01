import { describeGitHubContract } from '../github/github-contract.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeGitHub } from './fake-github.ts';

describeGitHubContract('the fake GitHub', async () => {
  const clock = new FakeClock();
  const github = new FakeGitHub(clock);
  const app = await github.createApp(github.manifestCode());
  github.install('acme/widgets');
  github.addIssue('acme/widgets#1');
  return { github, app, installedRepo: 'acme/widgets', uninstalledRepo: 'octocat/Hello-World', openIssue: 'acme/widgets#1', now: () => clock.now() };
});
