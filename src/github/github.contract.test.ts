// Seam 3: the GitHub port's REST adapter, as the factory identity's real App,
// against a throwaway repository (ADR 0004). It needs:
//
// - the App, created with `agents-factory setup github`, so its key is in
//   Windows Credential Manager under the operator's own factory home;
// - `FACTORY_CONTRACT_REPO`, the `owner/name` of a throwaway repository the
//   App is installed on, with an open issue numbered
//   `FACTORY_CONTRACT_ISSUE` (1 by default).
//
// Without them it is skipped. The App must not be installed on
// octocat/Hello-World, which stands for a repository it isn't on.
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { GITHUB_APP_SECRET } from '../daemon/daemon.ts';
import { factoryPaths } from '../daemon/paths.ts';
import { windowsCredentials } from '../secrets/secrets.ts';
import { describeGitHubContract } from './github-contract.ts';
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

if (!repo) {
  describe.skip('the GitHub App adapter (set FACTORY_CONTRACT_REPO to run it)', () => test('needs a throwaway repository', () => {}));
} else {
  describeGitHubContract('the GitHub App adapter', async () => ({
    github,
    app: await storedApp(),
    installedRepo: repo,
    uninstalledRepo: 'octocat/Hello-World',
    openIssue: `${repo}#${issue}`,
    now: () => Date.now(),
  }));

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
