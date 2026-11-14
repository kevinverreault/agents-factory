// The GitHub port's contract, shared by the fake and the REST adapter so the
// two can't drift apart.
import { describe, expect, test } from 'vitest';
import { CHECKS_READ, GitHubError, MERGE, OPEN_PR, PR_WRITE, PUSH, READ_ONLY, TICKET_WRITE, type FactoryApp, type GitHub, type Permissions, type PrStatus } from './github.ts';

export type GitHubFixture = {
  github: GitHub;
  // The factory identity's App, as `setup github` stored it.
  app: FactoryApp;
  // A repository the App is installed on, and one it isn't.
  installedRepo: string;
  uninstalledRepo: string;
  // An open issue of the installed repository, as `owner/name#n`.
  openIssue: string;
  // The operator reopens the issue by hand, as a test that closed it leaves it.
  reopenByHand(ref: string): Promise<void>;
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
  // Someone's CI sets a commit status named `context` on `commit` of the
  // installed repository, as the operator's own credentials can.
  setStatus(commit: string, context: string, state: 'pending' | 'success' | 'failure'): Promise<void>;
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

// The PR as read once GitHub has worked out whether it is mergeable, which
// it does in the background after a push: until then it says unknown.
async function workedOut(read: () => Promise<PrStatus>): Promise<PrStatus> {
  for (let tries = 1; ; tries++) {
    const status = await read();
    if (status.mergeable !== 'unknown' || tries === 30) return status;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

export function describeGitHubContract(name: string, makeFixture: () => Promise<GitHubFixture>): void {
  describe(`${name}: the GitHub contract`, () => {
    test('says whether the App is installed on a repository, and with which permissions', async () => {
      const { github, app, installedRepo, uninstalledRepo } = await makeFixture();

      const installation = await github.installation(app, installedRepo);
      expect(installation?.permissions).toMatchObject({ metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write' });
      // Where the operator approves the App's new permissions on that installation.
      expect(installation?.settingsUrl).toMatch(/^https:\/\/github\.com\/(settings|organizations\/[^/]+\/settings)\/installations\/\d+$/);
      expect(await github.installation(app, uninstalledRepo)).toBeNull();
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

    test('refuses to mint a token for a permission the installation doesn’t grant', async () => {
      const { github, app, installedRepo } = await makeFixture();

      // The App never asks for Administration (ADR 0004), so no installation grants it.
      const ungranted = { administration: 'read', metadata: 'read' } as unknown as Permissions;
      await expect(github.mintToken(app, installedRepo, ungranted)).rejects.toThrow(GitHubError);
    });

    test('a read-only token reads an open issue, but can’t close it', async () => {
      const { github, app, installedRepo, openIssue } = await makeFixture();
      const { token } = await github.mintToken(app, installedRepo, READ_ONLY);

      expect(await github.readIssue(token, openIssue)).toMatchObject({ ref: openIssue, open: true });
      await expect(github.closeIssue(token, openIssue, 'A read-only token can’t close this.')).rejects.toThrow(GitHubError);
      expect(await github.readIssue(token, openIssue)).toMatchObject({ open: true });
    });

    test('a ticket-writing token closes an issue', async () => {
      const { github, app, installedRepo, openIssue, reopenByHand } = await makeFixture();
      const { token } = await github.mintToken(app, installedRepo, TICKET_WRITE);

      await github.closeIssue(token, openIssue, 'Closed by the contract test.');

      expect(await github.readIssue(token, openIssue)).toMatchObject({ open: false });
      await reopenByHand(openIssue);
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

      expect((await github.readPr(read, ref)).state).toBe('open');
      await expect(github.closePr(read, ref, 'A read-only token can’t close this.')).rejects.toThrow(GitHubError);

      await github.closePr(write, ref, 'Closed by the contract test.');
      expect((await github.readPr(read, ref)).state).toBe('closed');
      await github.closePr(write, ref, 'Closed again by the contract test.');
      expect((await github.readPr(read, ref)).state).toBe('closed');

      await github.reopenPr(write, ref);
      expect((await github.readPr(read, ref)).state).toBe('open');
      await github.closePr(write, ref, 'Closed by the contract test.');
    });

    test('reads whether GitHub finds an open PR mergeable, once it has worked it out, or conflicting with its base', async () => {
      const { github, app, installedRepo, clone, operator, baseBranch } = await makeFixture();
      const path = `contract/${unique()}.txt`;
      // Two task branches change the same file differently: one PR merges
      // cleanly into the base branch, the other conflicts with the first.
      const [first, second] = [`factory/contract-${unique()}`, `factory/contract-${unique()}`];
      await clone.commitOn(first, { [path]: 'One side.\n' });
      await clone.commitOn(second, { [path]: 'The other side.\n' });
      const push = (await github.mintToken(app, installedRepo, PUSH)).token;
      for (const branch of [first, second]) await github.push(push, { clonePath: clone.path, repo: installedRepo, branch });
      const open = (await github.mintToken(app, installedRepo, OPEN_PR)).token;
      const pr = (head: string, base: string) => ({ repo: installedRepo, head, base, title: 'Contract test PR', body: '', assignee: operator });
      const clean = await github.openDraftPr(open, pr(first, baseBranch));
      const conflicting = await github.openDraftPr(open, pr(second, first));
      const read = (await github.mintToken(app, installedRepo, READ_ONLY)).token;

      expect(await workedOut(() => github.readPr(read, `${installedRepo}#${clean.number}`))).toMatchObject({ state: 'open', mergeable: 'mergeable' });
      expect(await workedOut(() => github.readPr(read, `${installedRepo}#${conflicting.number}`))).toMatchObject({ state: 'open', mergeable: 'conflicting' });
      const write = (await github.mintToken(app, installedRepo, PR_WRITE)).token;
      for (const { number } of [conflicting, clean]) await github.closePr(write, `${installedRepo}#${number}`, 'Closed by the contract test.');
    });

    test('a read-only token reads a PR’s head commit and whether it is a draft', async () => {
      const { github, app, installedRepo, clone, operator, baseBranch, draftsOffered } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      const tip = await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Read by the contract test.\n' });
      await github.push((await github.mintToken(app, installedRepo, PUSH)).token, { clonePath: clone.path, repo: installedRepo, branch });
      const draft = { repo: installedRepo, head: branch, base: baseBranch, title: 'Contract test PR', body: '', assignee: operator };
      const { number } = await github.openDraftPr((await github.mintToken(app, installedRepo, OPEN_PR)).token, draft);

      expect(await github.readPr((await github.mintToken(app, installedRepo, READ_ONLY)).token, `${installedRepo}#${number}`)).toMatchObject({ head: tip, draft: draftsOffered });
      await github.closePr((await github.mintToken(app, installedRepo, PR_WRITE)).token, `${installedRepo}#${number}`, 'Closed by the contract test.');
    });

    test('a checks token reads the combined checks of a commit: none, then pending, red or green as its statuses go, naming those that failed, while a read-only token can’t', async () => {
      const { github, app, installedRepo, clone, setStatus } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      const tip = await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Checked by the contract test.\n' });
      await github.push((await github.mintToken(app, installedRepo, PUSH)).token, { clonePath: clone.path, repo: installedRepo, branch });
      const { token } = await github.mintToken(app, installedRepo, CHECKS_READ);

      // The throwaway repository runs no workflow on a contract branch.
      expect(await github.readChecks(token, installedRepo, tip)).toEqual({ state: 'none', failed: [] });
      await setStatus(tip, 'contract/build', 'pending');
      expect(await github.readChecks(token, installedRepo, tip)).toEqual({ state: 'pending', failed: [] });
      await setStatus(tip, 'contract/build', 'success');
      expect(await github.readChecks(token, installedRepo, tip)).toEqual({ state: 'green', failed: [] });
      await setStatus(tip, 'contract/lint', 'failure');
      expect(await github.readChecks(token, installedRepo, tip)).toEqual({ state: 'red', failed: [{ name: 'contract/lint', url: null }] });
      await expect(github.readChecks((await github.mintToken(app, installedRepo, READ_ONLY)).token, installedRepo, tip)).rejects.toThrow(GitHubError);
    });

    test('a PR-writing token marks a draft ready, and marking it again is no error; a merge token merges it with a merge commit, but not while a draft, nor once its head moved', async () => {
      const { github, app, installedRepo, clone, operator, baseBranch, draftsOffered } = await makeFixture();
      const branch = `factory/contract-${unique()}`;
      const tip = await clone.commitOn(branch, { [`contract/${unique()}.txt`]: 'Merged by the contract test.\n' });
      await github.push((await github.mintToken(app, installedRepo, PUSH)).token, { clonePath: clone.path, repo: installedRepo, branch });
      const draft = { repo: installedRepo, head: branch, base: baseBranch, title: 'Contract test merge', body: 'Merged by the contract test.', assignee: operator };
      const { number } = await github.openDraftPr((await github.mintToken(app, installedRepo, OPEN_PR)).token, draft);
      const ref = `${installedRepo}#${number}`;
      const read = (await github.mintToken(app, installedRepo, READ_ONLY)).token;
      const merge = (await github.mintToken(app, installedRepo, MERGE)).token;
      await workedOut(() => github.readPr(read, ref));

      if (draftsOffered) await expect(github.mergePr(merge, ref, { method: 'merge', head: tip })).rejects.toThrow(GitHubError);
      await expect(github.markReady(read, ref)).rejects.toThrow(GitHubError);
      const write = (await github.mintToken(app, installedRepo, PR_WRITE)).token;
      await github.markReady(write, ref);
      await github.markReady(write, ref);
      expect((await github.readPr(read, ref)).draft).toBe(false);

      await expect(github.mergePr(write, ref, { method: 'merge', head: tip })).rejects.toThrow(GitHubError);
      await expect(github.mergePr(merge, ref, { method: 'merge', head: 'f'.repeat(40) })).rejects.toThrow(GitHubError);
      expect((await github.readPr(read, ref)).state).toBe('open');

      await github.mergePr(merge, ref, { method: 'merge', head: tip });
      expect((await github.readPr(read, ref)).state).toBe('merged');
      // Merged already, it is no error.
      await github.mergePr(merge, ref, { method: 'merge', head: tip });
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
      expect((await github.readPr(write, ref)).state).toBe('closed');
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

      await expect(github.installation({ ...app, privateKey }, installedRepo)).rejects.toThrow(GitHubError);
    });
  });
}
