// Seam 3: the GitHub port's REST adapter, as the factory identity's real App,
// against a throwaway repository (ADR 0004). It needs:
//
// - the App, created with `agents-factory setup github`, so its key is in
//   Windows Credential Manager under the operator's own factory home;
// - `FACTORY_CONTRACT_REPO`, the `owner/name` of a throwaway repository the
//   App is installed on, with an open issue numbered
//   `FACTORY_CONTRACT_ISSUE` (1 by default);
// - the operator's own `gh` login, and git credentials with the `workflow`
//   scope, which clone the repository, push by hand and clean up: the
//   branches the tests push are deleted afterwards, which closes their PRs.
//
// A private repository under GitHub Free, the operator's own or an
// organization's, offers no draft PRs, so the factory's are regular ones
// there: the tests read which from the repository and its owner's plan.
//
// Without them it is skipped. The App must not be installed on
// octocat/Hello-World, which stands for a repository it isn't on.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, test } from 'vitest';
import { GITHUB_APP_SECRET } from '../daemon/daemon.ts';
import { factoryPaths } from '../daemon/paths.ts';
import { windowsCredentials } from '../secrets/secrets.ts';
import { describeGitHubContract, type GitHubClone } from './github-contract.ts';
import { gitHubApi, READ_ONLY, type FactoryApp } from './github.ts';
import { writeRunGh } from './run-gh.ts';

const execFileAsync = promisify(execFile);
const repo = process.env.FACTORY_CONTRACT_REPO;
const issue = process.env.FACTORY_CONTRACT_ISSUE ?? '1';
const github = gitHubApi();

// The operator's own factory home, as `setup github` wrote it.
async function storedApp(): Promise<FactoryApp> {
  const { AGENTS_FACTORY_HOME, ...env } = process.env;
  const stored = await windowsCredentials(factoryPaths(env).credentialPrefix).read(GITHUB_APP_SECRET);
  if (!stored) throw new Error('No factory App is stored: run `agents-factory setup github` first.');
  return JSON.parse(stored) as FactoryApp;
}

// `gh` as an AFK run calls it: the operator's login removed, the run's config dir set.
function gh(runEnv: Record<string, string>, args: string[]): Promise<{ ok: boolean; output: string }> {
  const { GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN, ...env } = process.env;
  return execFileAsync('gh', args, { env: { ...env, ...runEnv } }).then(
    ({ stdout }) => ({ ok: true, output: stdout.trim() }),
    (error: { stdout: string; stderr: string }) => ({ ok: false, output: `${error.stdout}${error.stderr}`.trim() }),
  );
}

// Revokes an installation token, as its expiry would.
async function revoke(token: string): Promise<void> {
  const response = await fetch('https://api.github.com/installation/token', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'agents-factory' },
  });
  expect(response.status).toBe(204);
}

// Git as the operator, with their own credentials.
async function operatorGit(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout.trim();
}

// Whether GitHub offers draft PRs on the repository: on a public one, and on
// a private one unless its owner, the operator or an organization, is on
// GitHub Free.
async function draftsOfferedOn(repo: string): Promise<boolean> {
  const ghJson = async (path: string) => JSON.parse((await execFileAsync('gh', ['api', path])).stdout);
  const { private: isPrivate, owner } = await ghJson(`repos/${repo}`);
  if (!isPrivate) return true;
  const { plan } = await ghJson(owner.type === 'Organization' ? `orgs/${owner.login}` : 'user');
  return plan?.name !== 'free';
}

// One clone of the repository for every test, and the branches they cut in it.
let cloned: Promise<{ clone: GitHubClone; baseBranch: string }> | null = null;
const cut: string[] = [];
let draftsOffered: Promise<boolean> | null = null;

async function cloneOnce(repo: string): Promise<{ clone: GitHubClone; baseBranch: string }> {
  const path = join(mkdtempSync(join(tmpdir(), 'factory-contract-clone-')), 'repo');
  await execFileAsync('git', ['clone', '--quiet', `https://github.com/${repo}.git`, path]);
  const baseBranch = (await operatorGit(path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).replace(/^origin\//, '');
  const clone: GitHubClone = {
    path,
    async commitOn(branch, files) {
      cut.push(branch);
      await operatorGit(path, 'checkout', '--quiet', '-b', branch, `origin/${baseBranch}`);
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(dirname(join(path, file)), { recursive: true });
        writeFileSync(join(path, file), content);
      }
      await operatorGit(path, 'add', '--', ...Object.keys(files));
      await operatorGit(path, '-c', 'user.name=Contract test', '-c', 'user.email=contract@example.invalid', 'commit', '--quiet', '-m', 'Contract test commit');
      return operatorGit(path, 'rev-parse', 'HEAD');
    },
    async remoteTip(branch) {
      return (await operatorGit(path, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`)).split(/\s/, 1)[0] || null;
    },
    async pushByHand(branch) {
      await operatorGit(path, 'push', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
    },
  };
  return { clone, baseBranch };
}

if (!repo) {
  describe.skip('the GitHub App adapter (set FACTORY_CONTRACT_REPO to run it)', () => test('needs a throwaway repository', () => {}));
} else {
  afterAll(async () => {
    if (!cloned) return;
    const { clone } = await cloned;
    for (const branch of cut) if (await clone.remoteTip(branch)) await operatorGit(clone.path, 'push', '--quiet', 'origin', '--delete', branch);
  });

  describeGitHubContract('the GitHub App adapter', async () => {
    const { clone, baseBranch } = await (cloned ??= cloneOnce(repo));
    return {
      github,
      app: await storedApp(),
      installedRepo: repo,
      uninstalledRepo: 'octocat/Hello-World',
      openIssue: `${repo}#${issue}`,
      async reopenByHand(ref) {
        await execFileAsync('gh', ['issue', 'reopen', ref.split('#')[1]!, '--repo', repo]);
      },
      now: () => Date.now(),
      clone,
      baseBranch,
      operator: (await execFileAsync('gh', ['api', 'user', '--jq', '.login'])).stdout.trim(),
      draftsOffered: await (draftsOffered ??= draftsOfferedOn(repo)),
      async pullRequest(number) {
        const pr = JSON.parse((await execFileAsync('gh', ['api', `repos/${repo}/pulls/${number}`])).stdout);
        return {
          draft: pr.draft,
          head: pr.head.ref,
          base: pr.base.ref,
          title: pr.title,
          body: pr.body ?? '',
          assignees: (pr.assignees as { login: string }[]).map(({ login }) => login),
        };
      },
    };
  });

  describe('an AFK run’s gh, with the read-only bot token', () => {
    test('can `gh issue view`, but not write', async () => {
      const app = await storedApp();
      const dir = mkdtempSync(join(tmpdir(), 'factory-run-gh-'));
      const { token } = await github.mintToken(app, repo, READ_ONLY);
      const env = writeRunGh(dir, `${app.slug}[bot]`, token);

      const viewed = await gh(env, ['issue', 'view', issue, '--repo', repo, '--json', 'number']);
      expect(viewed).toEqual({ ok: true, output: JSON.stringify({ number: Number(issue) }) });

      const commented = await gh(env, ['issue', 'comment', issue, '--repo', repo, '--body', 'A read-only token can’t write this.']);
      expect(commented.ok).toBe(false);
      expect(commented.output).toMatch(/Resource not accessible by integration|HTTP 403/);
      await revoke(token);
    });

    test('keeps working once the daemon refreshes the token in place, mid-run', async () => {
      const app = await storedApp();
      const dir = mkdtempSync(join(tmpdir(), 'factory-run-gh-'));
      const first = await github.mintToken(app, repo, READ_ONLY);
      const env = writeRunGh(dir, `${app.slug}[bot]`, first.token);
      expect((await gh(env, ['issue', 'view', issue, '--repo', repo, '--json', 'number'])).ok).toBe(true);

      // The first token stops working, as it would at its expiry, and the refreshed one takes its place.
      await revoke(first.token);
      expect((await gh(env, ['issue', 'view', issue, '--repo', repo, '--json', 'number'])).ok).toBe(false);
      const refreshed = await github.mintToken(app, repo, READ_ONLY);
      writeRunGh(dir, `${app.slug}[bot]`, refreshed.token);

      expect((await gh(env, ['issue', 'view', issue, '--repo', repo, '--json', 'number'])).ok).toBe(true);
      await revoke(refreshed.token);
    });
  });
}
