// The GitHub port's contract, shared by the fake and the REST adapter so the
// two can't drift apart.
import { describe, expect, test } from 'vitest';
import { GitHubError, READ_ONLY, TICKET_WRITE, type FactoryApp, type GitHub } from './github.ts';

export type GitHubFixture = {
  github: GitHub;
  // The factory identity's App, as `setup github` stored it.
  app: FactoryApp;
  // A repository the App is installed on, and one it isn't.
  installedRepo: string;
  uninstalledRepo: string;
  // An open issue of the installed repository, as `owner/name#n`.
  openIssue: string;
  // GitHub's time now.
  now(): number;
};

const HOUR = 60 * 60_000;

export function describeGitHubContract(name: string, makeFixture: () => Promise<GitHubFixture>): void {
  describe(`${name}: the GitHub contract`, () => {
    test('says whether the App is installed on a repository', async () => {
      const { github, app, installedRepo, uninstalledRepo } = await makeFixture();

      expect(await github.isInstalled(app, installedRepo)).toBe(true);
      expect(await github.isInstalled(app, uninstalledRepo)).toBe(false);
    });

    test('mints a token for a repository it is installed on, which lives at most an hour', async () => {
      const { github, app, installedRepo, now } = await makeFixture();

      const minted = await github.mintToken(app, installedRepo, READ_ONLY);

      expect(minted.token).toMatch(/^ghs_/);
      expect(minted.expiresAt).toBeGreaterThan(now() + HOUR / 2);
      expect(minted.expiresAt).toBeLessThanOrEqual(now() + HOUR + 60_000);
    });

    test('refuses to mint a token for a repository it isn’t installed on', async () => {
      const { github, app, uninstalledRepo } = await makeFixture();

      await expect(github.mintToken(app, uninstalledRepo, READ_ONLY)).rejects.toThrow(GitHubError);
    });

    test('a read-only token reads an open issue, but can’t close it', async () => {
      const { github, app, installedRepo, openIssue } = await makeFixture();
      const { token } = await github.mintToken(app, installedRepo, READ_ONLY);

      expect(await github.readIssue(token, openIssue)).toMatchObject({ ref: openIssue, open: true });
      await expect(github.closeIssue(token, openIssue, 'A read-only token can’t close this.')).rejects.toThrow(GitHubError);
      await expect(github.reopenIssue(token, openIssue, 'A read-only token can’t reopen this.')).rejects.toThrow(GitHubError);
      expect(await github.readIssue(token, openIssue)).toMatchObject({ open: true });
    });

    test('a ticket-writing token closes an issue and reopens it, leaving it open', async () => {
      const { github, app, installedRepo, openIssue } = await makeFixture();
      const { token } = await github.mintToken(app, installedRepo, TICKET_WRITE);

      await github.closeIssue(token, openIssue, 'Closed by the contract test.');
      expect(await github.readIssue(token, openIssue)).toMatchObject({ open: false });
      await github.reopenIssue(token, openIssue, 'Reopened by the contract test.');

      expect(await github.readIssue(token, openIssue)).toMatchObject({ open: true });
    });

    test('refuses an App whose private key isn’t the one GitHub issued', async () => {
      const { github, app, installedRepo } = await makeFixture();
      const { privateKey } = await import('node:crypto').then(({ generateKeyPairSync }) =>
        generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }),
      );

      await expect(github.isInstalled({ ...app, privateKey }, installedRepo)).rejects.toThrow(GitHubError);
    });
  });
}
