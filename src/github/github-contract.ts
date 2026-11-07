// The GitHub port's contract, shared by the fake and the REST adapter so the
// two can't drift apart.
import { describe, expect, test } from 'vitest';
import { GitHubError, OPEN_PR, PR_WRITE, PUSH, READ_ONLY, TICKET_WRITE, type FactoryApp, type GitHub } from './github.ts';

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
  // A clone of the installed repository on the operator's machine.
  clone: GitHubClone;
  // The operator's login: the App's owner.
  operator: string;
  // The installed repository's base branch.
  baseBranch: string;
  // Whether GitHub offers draft PRs on the installed repository: not on a
  // private one under GitHub Free.
  draftsOffered: boolean;
  // A PR of the installed repository as GitHub has it.
  pullRequest(number: number): Promise<{ draft: boolean; head: string; base: string; title: string; body: string; assignees: string[] }>;
};

// The clone the factory pushes from, as a test drives it.
export type GitHubClone = {
  path: string;
  // Cuts the local `branch` from the base branch and commits `files` (by
  // path, with `/`) onto it, returning its tip.
  commitOn(branch: string, files: Record<string, string>): Promise<string>;
  // The branch's tip on GitHub, or null when GitHub has no such branch.
  remoteTip(branch: string): Promise<string | null>;
  // The operator pushes the branch by hand, with their own credentials.
  pushByHand(branch: string): Promise<void>;
};

const HOUR = 60 * 60_000;

// A workflow that never runs: nothing dispatches it.
const WORKFLOW = 'on: workflow_dispatch\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n';

// A branch name of its own for each test, so runs against a real repository never meet.
const unique = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

    test('a push token pushes the task branch to the same branch on GitHub', async () => {
      const { github, app, installedRepo, clone } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      const tip = await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Pushed by the contract test.\n' });
      const { token } = await github.mintToken(app, installedRepo, PUSH);

      expect(await github.push(token, { clonePath: clone.path, repo: installedRepo, branch })).toEqual({ pushed: tip });

      expect(await clone.remoteTip(branch)).toBe(tip);
    });

    test('a read-only token can’t push, and a push token can’t write issues', async () => {
      const { github, app, installedRepo, openIssue, clone } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Never pushed.\n' });
      const readOnly = await github.mintToken(app, installedRepo, READ_ONLY);
      const push = await github.mintToken(app, installedRepo, PUSH);

      await expect(github.push(readOnly.token, { clonePath: clone.path, repo: installedRepo, branch })).rejects.toThrow(GitHubError);
      await expect(github.closeIssue(push.token, openIssue, 'A push token can’t close this.')).rejects.toThrow(GitHubError);

      expect(await clone.remoteTip(branch)).toBeNull();
      expect(await github.readIssue(readOnly.token, openIssue)).toMatchObject({ open: true });
    });

    test('refuses to push a branch that isn’t a task or research branch, pushing nothing', async () => {
      const { github, app, installedRepo, clone } = await makeFixture();
      const branch = `contract/not-a-task-branch-${unique()}`;
      await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Never pushed.\n' });
      const { token } = await github.mintToken(app, installedRepo, PUSH);

      await expect(github.push(token, { clonePath: clone.path, repo: installedRepo, branch })).rejects.toThrow(
        `The factory pushes only task branches (factory/…) and research branches (research/…), not ${branch}.`,
      );

      expect(await clone.remoteTip(branch)).toBeNull();
    });

    test('pushes a research branch whose commits touch only docs/research/**', async () => {
      const { github, app, installedRepo, clone } = await makeFixture();
      const branch = `research/contract-${unique()}`;
      const tip = await clone.commitOn(branch, { [`docs/research/contract-${unique()}.md`]: 'Findings.\n' });
      const { token } = await github.mintToken(app, installedRepo, PUSH);

      expect(await github.push(token, { clonePath: clone.path, repo: installedRepo, branch })).toEqual({ pushed: tip });

      expect(await clone.remoteTip(branch)).toBe(tip);
    });

    test('refuses to push a research branch whose commits touch any other path, pushing nothing', async () => {
      const { github, app, installedRepo, clone } = await makeFixture();
      const branch = `research/contract-${unique()}`;
      const other = `contract/${unique()}.txt`;
      await clone.commitOn(branch, { [`docs/research/contract-${unique()}.md`]: 'Findings.\n', [other]: 'Never pushed.\n' });
      const { token } = await github.mintToken(app, installedRepo, PUSH);

      expect(await github.push(token, { clonePath: clone.path, repo: installedRepo, branch })).toEqual({ outsideResearch: [other] });

      expect(await clone.remoteTip(branch)).toBeNull();
    });

    test('refuses to push a branch whose commits change workflow files, pushing nothing', async () => {
      const { github, app, installedRepo, clone } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      const workflow = `.github/workflows/contract-${unique()}.yml`;
      await clone.commitOn(branch, { [workflow]: WORKFLOW, [`contract/${unique()}.txt`]: 'Never pushed.\n' });
      const { token } = await github.mintToken(app, installedRepo, PUSH);

      expect(await github.push(token, { clonePath: clone.path, repo: installedRepo, branch })).toEqual({ workflowFiles: [workflow] });

      expect(await clone.remoteTip(branch)).toBeNull();
    });

    test('a branch the operator pushed by hand counts as pushed, workflow files and all', async () => {
      const { github, app, installedRepo, clone } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      const tip = await clone.commitOn(branch, { [`.github/workflows/contract-${unique()}.yml`]: WORKFLOW });
      await clone.pushByHand(branch);
      const { token } = await github.mintToken(app, installedRepo, PUSH);

      expect(await github.push(token, { clonePath: clone.path, repo: installedRepo, branch })).toEqual({ pushed: tip });
    });

    test('names the App’s owner, the operator', async () => {
      const { github, app, operator } = await makeFixture();

      expect(await github.appOwner(app)).toBe(operator);
    });

    test('a PR token opens a draft PR of a pushed task branch (a regular one where GitHub offers no drafts), assigned to the operator, and opening it again finds the same PR', async () => {
      const { github, app, installedRepo, clone, operator, baseBranch, draftsOffered, pullRequest } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Opened as a draft by the contract test.\n' });
      await github.push((await github.mintToken(app, installedRepo, PUSH)).token, { clonePath: clone.path, repo: installedRepo, branch });
      const { token } = await github.mintToken(app, installedRepo, OPEN_PR);
      const draft = { repo: installedRepo, head: branch, base: baseBranch, title: 'Contract test draft', body: 'Opened by the contract test.', assignee: operator };

      const opened = await github.openDraftPr(token, draft);

      expect(opened).toMatchObject({ url: `https://github.com/${installedRepo}/pull/${opened.number}`, draft: draftsOffered });
      expect(await pullRequest(opened.number)).toEqual({
        draft: draftsOffered,
        head: branch,
        base: baseBranch,
        title: 'Contract test draft',
        body: 'Opened by the contract test.',
        assignees: [operator],
      });
      expect(await github.openDraftPr(token, draft)).toEqual(opened);
    });

    test('a push token can’t open a PR', async () => {
      const { github, app, installedRepo, clone, operator, baseBranch } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Pushed, never opened.\n' });
      const { token } = await github.mintToken(app, installedRepo, PUSH);
      await github.push(token, { clonePath: clone.path, repo: installedRepo, branch });

      await expect(
        github.openDraftPr(token, { repo: installedRepo, head: branch, base: baseBranch, title: 'Never opened', body: '', assignee: operator }),
      ).rejects.toThrow(GitHubError);
    });

    test('a token that can write PRs but not read Contents can’t open one: GitHub must read its branches', async () => {
      const { github, app, installedRepo, clone, operator, baseBranch } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Pushed, never opened.\n' });
      await github.push((await github.mintToken(app, installedRepo, PUSH)).token, { clonePath: clone.path, repo: installedRepo, branch });
      const { token } = await github.mintToken(app, installedRepo, { pull_requests: 'write', metadata: 'read' });

      await expect(
        github.openDraftPr(token, { repo: installedRepo, head: branch, base: baseBranch, title: 'Never opened', body: '', assignee: operator }),
      ).rejects.toThrow(GitHubError);
    });

    test('a read-only token reads where a PR stands, and a PR-writing token closes it, leaves it closed when closed again, and reopens it', async () => {
      const { github, app, installedRepo, clone, operator, baseBranch } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Closed and reopened by the contract test.\n' });
      await github.push((await github.mintToken(app, installedRepo, PUSH)).token, { clonePath: clone.path, repo: installedRepo, branch });
      const draft = { repo: installedRepo, head: branch, base: baseBranch, title: 'Contract test PR', body: '', assignee: operator };
      const { number } = await github.openDraftPr((await github.mintToken(app, installedRepo, OPEN_PR)).token, draft);
      const ref = `${installedRepo}#${number}`;
      const read = (await github.mintToken(app, installedRepo, READ_ONLY)).token;
      const write = (await github.mintToken(app, installedRepo, PR_WRITE)).token;

      expect(await github.readPr(read, ref)).toBe('open');
      await expect(github.closePr(read, ref, 'A read-only token can’t close this.')).rejects.toThrow(GitHubError);

      await github.closePr(write, ref, 'Closed by the contract test.');
      expect(await github.readPr(read, ref)).toBe('closed');
      await github.closePr(write, ref, 'Closed again by the contract test.');
      expect(await github.readPr(read, ref)).toBe('closed');

      await github.reopenPr(write, ref);
      expect(await github.readPr(read, ref)).toBe('open');
      await github.closePr(write, ref, 'Closed by the contract test.');
    });

    test('a PR whose head branch GitHub no longer has can’t be reopened, and says why', async () => {
      const { github, app, installedRepo, clone, operator, baseBranch } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Closed for good by the contract test.\n' });
      const push = (await github.mintToken(app, installedRepo, PUSH)).token;
      await github.push(push, { clonePath: clone.path, repo: installedRepo, branch });
      const draft = { repo: installedRepo, head: branch, base: baseBranch, title: 'Contract test PR', body: '', assignee: operator };
      const { number } = await github.openDraftPr((await github.mintToken(app, installedRepo, OPEN_PR)).token, draft);
      const ref = `${installedRepo}#${number}`;
      const write = (await github.mintToken(app, installedRepo, PR_WRITE)).token;
      await github.closePr(write, ref, 'Closed by the contract test.');
      await github.deleteBranch(push, installedRepo, branch);

      await expect(github.reopenPr(write, ref)).rejects.toThrow(`${branch} is gone from GitHub, so #${number} can’t be reopened.`);
      expect(await github.readPr(write, ref)).toBe('closed');
    });

    test('a push token deletes a pushed task branch, and deleting it again is no error, while a read-only token can’t', async () => {
      const { github, app, installedRepo, clone } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Deleted by the contract test.\n' });
      const { token } = await github.mintToken(app, installedRepo, PUSH);
      await github.push(token, { clonePath: clone.path, repo: installedRepo, branch });

      await expect(github.deleteBranch((await github.mintToken(app, installedRepo, READ_ONLY)).token, installedRepo, branch)).rejects.toThrow(GitHubError);
      expect(await clone.remoteTip(branch)).not.toBeNull();

      await github.deleteBranch(token, installedRepo, branch);
      expect(await clone.remoteTip(branch)).toBeNull();
      await github.deleteBranch(token, installedRepo, branch);
    });

    test('refuses to delete a branch that isn’t a task branch', async () => {
      const { github, app, installedRepo, baseBranch } = await makeFixture();
      const { token } = await github.mintToken(app, installedRepo, PUSH);

      await expect(github.deleteBranch(token, installedRepo, baseBranch)).rejects.toThrow(`The factory deletes only task branches (factory/…) on GitHub, not ${baseBranch}.`);
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
