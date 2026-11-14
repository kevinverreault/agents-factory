// The GitHub port (ADR 0004): what the factory asks GitHub as its factory
// identity, a GitHub App. It turns the manifest flow's code into the App,
// says whether the App is installed on a repository and with which
// permissions, and mints installation tokens narrowed to one repository and
// the permissions asked for. With such a token it reads specs, maps and
// their tickets, closes them (ADR 0013), pushes task branches, and opens
// their draft PRs, reads those PRs and the checks on their heads, closes or
// reopens them, marks them ready and merges them (ADR 0014), and deletes the
// task branches it pushed (ADR 0011). The REST adapter (`gitHubApi`) is the real one.
import { execFile } from 'node:child_process';
import { sign } from 'node:crypto';
import { issueRef } from '../artifacts/capture.ts';
import { isResearchBranch, outsideResearch } from './research-branch.ts';

// The factory identity's App as the daemon keeps it, private key included, in
// the credential store.
export type FactoryApp = { id: number; slug: string; privateKey: string };

export type Permission = 'contents' | 'issues' | 'pull_requests' | 'metadata' | 'checks' | 'statuses';
export type Permissions = Partial<Record<Permission, 'read' | 'write'>>;

// What an AFK run reads GitHub with, and the daemon reads a root's PR with
// (ADR 0011): Issues, Pull requests and Metadata read.
export const READ_ONLY: Permissions = { issues: 'read', pull_requests: 'read', metadata: 'read' };

// What closing a ticket writes with: a comment and the issue's state.
export const TICKET_WRITE: Permissions = { issues: 'write', metadata: 'read' };

// What pushing a task branch writes with: the repository's contents alone.
export const PUSH: Permissions = { contents: 'write', metadata: 'read' };

// What opening a PR, and assigning it, writes with: pull requests alone, and
// Contents read, without which GitHub can't read the branches ("not all refs
// are readable").
export const OPEN_PR: Permissions = { contents: 'read', pull_requests: 'write', metadata: 'read' };

// What reading a PR's checks reads with: its head's check runs and commit
// statuses alone (ADR 0014).
export const CHECKS_READ: Permissions = { checks: 'read', statuses: 'read', metadata: 'read' };

// What merging a PR writes with: GitHub writes the merge commit to the base
// branch, so it needs Contents write besides Pull requests write.
export const MERGE: Permissions = { contents: 'write', pull_requests: 'write', metadata: 'read' };

export type InstallationToken = { token: string; expiresAt: number };

// The App's installation on a repository as GitHub has it: the permissions
// the operator granted it, which lag the App's own until they approve a
// change of them, as when the App gains a permission (ADR 0014), and the
// installation's settings page, where they approve it.
export type Installation = { permissions: Permissions; settingsUrl: string };

// What the factory pushes (ADR 0004): the task branch, or a research
// branch (ADR 0007), of the clone at `clonePath`, to the branch of the same
// name in the repository `repo`.
export type BranchPush = { clonePath: string; repo: string; branch: string };
// The tip GitHub has of the branch once pushed, or, unpushed, the workflow
// files its commits change: the App has no Workflows permission, so the
// operator pushes those by hand (ADR 0004); or, for a research branch, the
// paths its commits change outside `docs/research/` (ADR 0007).
export type Pushed = { pushed: string } | { workflowFiles: string[] } | { outsideResearch: string[] };

// What closing a draft PR, with its comment, or reopening it, writes with:
// pull requests alone.
export const PR_WRITE: Permissions = { pull_requests: 'write', metadata: 'read' };

// Where a PR stands on GitHub: open, merged, or closed without merging.
export type PrState = 'open' | 'merged' | 'closed';
// Whether GitHub finds the PR mergeable into its base, or conflicting with
// it, or unknown while it is still working that out after a push (ADR 0013),
// as it may stay for a PR that isn't open.
export type Mergeability = 'mergeable' | 'conflicting' | 'unknown';
// What a read of a PR says of it: also its head commit, which its checks
// ran on, and whether it is a draft.
export type PrStatus = { state: PrState; mergeable: Mergeability; head: string; draft: boolean };

// The combined state of the check runs and commit statuses on a commit
// (ADR 0014): green once every one passed, red once any failed, pending
// while any hasn't finished, and none when the repository runs none.
export type ChecksState = 'green' | 'red' | 'pending' | 'none';
// A check run or commit status that failed: its name, and the page that
// says why, if GitHub has one.
export type FailedCheck = { name: string; url: string | null };
// A commit's checks as the gate reads them: their combined state, and those
// that failed, for the fix run a red check gets (ADR 0014).
export type Checks = { state: ChecksState; failed: FailedCheck[] };

// How the factory merges a PR: with a merge commit by default, which keeps
// the bot's commits and the operator's HITL commits apart (ADR 0004).
export type MergeMethod = 'merge' | 'squash' | 'rebase';
// The merge of a PR: by `method`, and only while its head is still `head`,
// the commit whose checks let it through.
export type PrMerge = { method: MergeMethod; head: string };

// A draft PR the factory opens (ADR 0004): of the pushed task branch `head`
// into `base`, assigned to `assignee`, the operator.
export type DraftPr = { repo: string; head: string; base: string; title: string; body: string; assignee: string };
// `draft` is false where GitHub offers no draft PRs, as on a private
// repository under GitHub Free, and the factory opened a regular one.
export type PullRequest = { number: number; url: string; draft: boolean };

// Those of `paths` (from the top, with `/`) that are workflow files.
export function workflowFiles(paths: string[]): string[] {
  return paths.filter((path) => path.startsWith('.github/workflows/'));
}

// An issue (`owner/name#n`) as a loop reads it: its title, whether it is
// open, its labels, and the open issues blocking it (GitHub's native dependencies).
export type Issue = { ref: string; title: string; open: boolean; labels: string[]; openBlockers: string[] };

export interface GitHub {
  // The App GitHub created from the factory's manifest, by the code its
  // redirect carried back (valid for an hour).
  createApp(code: string): Promise<FactoryApp>;
  // The App's installation on the repository (`owner/name`), with the
  // permissions it grants, or null when the App isn't installed there.
  installation(app: FactoryApp, repo: string): Promise<Installation | null>;
  // A token of the App's installation on the repository, for that repository
  // alone and with those permissions alone.
  mintToken(app: FactoryApp, repo: string, permissions: Permissions): Promise<InstallationToken>;
  // The issue's sub-issues, in their order on GitHub, read with `token`.
  subIssues(token: string, ref: string): Promise<string[]>;
  readIssue(token: string, ref: string): Promise<Issue>;
  // Comments `comment` on the issue, then closes it as completed, with
  // `token`, which needs Issues write.
  closeIssue(token: string, ref: string, comment: string): Promise<void>;
  // Pushes the task branch with `token`, which needs Contents write, under a
  // fixed refspec: the branch's tip to the same branch on GitHub, never
  // forced, and with no hooks run. A branch GitHub already has at that tip,
  // such as one the operator pushed by hand, is pushed already. Otherwise a
  // branch whose commits GitHub doesn't have change workflow files isn't
  // pushed. Throws a `GitHubError` when the refspec guard or GitHub refuses it.
  push(token: string, push: BranchPush): Promise<Pushed>;
  // Opens the draft PR with `token`, which needs Pull requests write, and
  // assigns it; or finds the open PR of its head branch, as when the factory
  // stopped before it could record that it opened it. Where GitHub offers no
  // draft PRs, it opens a regular one instead.
  openDraftPr(token: string, pr: DraftPr): Promise<PullRequest>;
  // Where the PR `ref` (`owner/name#n`) stands, and whether it is
  // mergeable, read with `token`, which needs Pull requests read (ADR 0011).
  readPr(token: string, ref: string): Promise<PrStatus>;
  // The checks on the commit `head` of the repository `repo`, combined, and
  // those that failed, read with `token`, which needs Checks and Statuses read.
  readChecks(token: string, repo: string, head: string): Promise<Checks>;
  // Marks the draft PR `ref` ready for review, with `token`, which needs
  // Pull requests write. A PR already ready is left as it is.
  markReady(token: string, ref: string): Promise<void>;
  // Merges the open PR `ref` into its base, with `token`, which needs
  // Contents and Pull requests write. A PR already merged is merged already.
  // Throws a `GitHubError` when GitHub refuses it: a draft, a conflict, or
  // a head that moved past `merge.head`.
  mergePr(token: string, ref: string, merge: PrMerge): Promise<void>;
  // Comments `comment` on the open PR, then closes it, with `token`, which
  // needs Pull requests write. A PR already closed or merged is left as it is.
  closePr(token: string, ref: string, comment: string): Promise<void>;
  // Reopens the PR closed unmerged, with `token`, which needs Pull requests
  // write. Throws a `GitHubError` saying so when GitHub no longer has its
  // head branch, without which it can't be reopened.
  reopenPr(token: string, ref: string): Promise<void>;
  // Deletes the task branch on GitHub with `token`, which needs Contents
  // write, under the same refspec guard as `push`. A branch GitHub no longer
  // has, such as one its auto-delete removed, is deleted already. Throws a
  // `GitHubError` when the guard or GitHub refuses it.
  deleteBranch(token: string, repo: string, branch: string): Promise<void>;
  // The login of the account that owns the App: the operator's, whose
  // account `setup github` created it on.
  appOwner(app: FactoryApp): Promise<string>;
}

// GitHub couldn't be reached, or refused, saying why.
export class GitHubError extends Error {}

// The refspec guard (ADR 0004): the factory pushes task branches
// (`factory/<id>-<slug>`) and research branches (`research/<name>`, ADR
// 0007) and nothing else, so a token that could write any branch never
// writes the base branch. Why `branch` can't be pushed, or null.
export function pushRefusal(branch: string): string | null {
  return TASK_BRANCH.test(branch) || isResearchBranch(branch)
    ? null
    : `The factory pushes only task branches (factory/…) and research branches (research/…), not ${branch}.`;
}

// Why the factory won't delete `branch` on GitHub, or null: it deletes only
// the task branches it pushed (ADR 0011). A research branch is the map's
// context pointer, so it stays.
export function deleteRefusal(branch: string): string | null {
  return TASK_BRANCH.test(branch) ? null : `The factory deletes only task branches (factory/…) on GitHub, not ${branch}.`;
}

// A task branch, `factory/<id>-<slug>`.
const TASK_BRANCH = /^factory\/[\w.-]+$/;

// Where the operator installs the App, or changes which repositories an
// installation covers.
export function installationSettings(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}

// The kind of account an installation is on, as GitHub says.
export type AccountType = 'User' | 'Organization';

// An installation's own settings page, on the account it is installed on:
// where the operator approves the App's new permissions.
export function installationPage(id: number, account: string, accountType: AccountType): string {
  return accountType === 'Organization'
    ? `https://github.com/organizations/${account}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

// The App's permissions (ADR 0004): no Workflows, Actions or Administration,
// and Checks and Statuses read alone, for L3's merges (ADR 0014).
export const APP_PERMISSIONS: Permissions = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  metadata: 'read',
  checks: 'read',
  statuses: 'read',
};

const API = 'https://api.github.com';
// How long a call may take before GitHub counts as unreachable.
const TIMEOUT_MS = 30_000;

// The REST API.
export function gitHubApi(): GitHub {
  async function call(method: string, path: string, auth: string | null, body?: object): Promise<{ status: number; json: any }> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'agents-factory',
          ...(auth && { authorization: `Bearer ${auth}` }),
          ...(body && { 'content-type': 'application/json' }),
        },
        ...(body && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new GitHubError(`GitHub couldn’t be reached: ${(error as Error).message}`);
    }
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: response.status, json };
  }

  // With what GitHub said, and each validation error's own message.
  const refused = (what: string, { status, json }: { status: number; json: any }) => {
    const said = [json?.message, ...((json?.errors as { message?: string }[] | undefined) ?? []).map((error) => error.message)].filter(Boolean);
    return new GitHubError(`GitHub refused to ${what} (HTTP ${status}${said.length ? `: ${said.join(': ')}` : ''}).`);
  };

  // The installation covering the repository, or null when there is none.
  async function installationOf(app: FactoryApp, repo: string): Promise<({ id: number } & Installation) | null> {
    const reply = await call('GET', `/repos/${repo}/installation`, appJwt(app));
    if (reply.status === 404) return null;
    if (reply.status !== 200) throw refused(`say whether the App is installed on ${repo}`, reply);
    const id = reply.json.id as number;
    const { login, type } = reply.json.account as { login: string; type: AccountType };
    return { id, permissions: { ...(reply.json.permissions as Permissions) }, settingsUrl: installationPage(id, login, type) };
  }

  // The PR `ref` as GitHub has it.
  async function pullRequest(token: string, ref: string): Promise<any> {
    const reply = await call('GET', pullPath(ref), token);
    if (reply.status !== 200) throw refused(`read ${ref}`, reply);
    return reply.json;
  }

  // Each page of a listing, a hundred at a time.
  async function list(path: string, token: string, what: string): Promise<any[]> {
    const items: any[] = [];
    for (let page = 1; ; page++) {
      const reply = await call('GET', `${path}?per_page=100&page=${page}`, token);
      if (reply.status !== 200) throw refused(what, reply);
      items.push(...reply.json);
      if (reply.json.length < 100) return items;
    }
  }

  return {
    async createApp(code) {
      const reply = await call('POST', `/app-manifests/${encodeURIComponent(code)}/conversions`, null);
      if (reply.status !== 201) throw refused('create the App from its manifest', reply);
      const { id, slug, pem } = reply.json as { id: number; slug: string; pem: string };
      return { id, slug, privateKey: pem };
    },
    async installation(app, repo) {
      const found = await installationOf(app, repo);
      return found && { permissions: found.permissions, settingsUrl: found.settingsUrl };
    },
    async mintToken(app, repo, permissions) {
      const installation = await installationOf(app, repo);
      if (installation === null) throw new GitHubError(`The factory’s App isn’t installed on ${repo}.`);
      const reply = await call('POST', `/app/installations/${installation.id}/access_tokens`, appJwt(app), {
        repositories: [repo.split('/')[1]],
        permissions,
      });
      if (reply.status !== 201) throw refused(`mint a token for ${repo}`, reply);
      return { token: reply.json.token, expiresAt: Date.parse(reply.json.expires_at) };
    },
    async subIssues(token, ref) {
      const issues = await list(`${issuePath(ref)}/sub_issues`, token, `list the sub-issues of ${ref}`);
      return issues.map((issue) => issueRef(issue.html_url));
    },
    async readIssue(token, ref) {
      const reply = await call('GET', issuePath(ref), token);
      if (reply.status !== 200) throw refused(`read ${ref}`, reply);
      const blockers = await list(`${issuePath(ref)}/dependencies/blocked_by`, token, `read what blocks ${ref}`);
      return {
        ref,
        title: String(reply.json.title ?? ''),
        open: reply.json.state === 'open',
        labels: (reply.json.labels as { name: string }[]).map(({ name }) => name),
        openBlockers: blockers.filter((issue) => issue.state === 'open').map((issue) => issueRef(issue.html_url)),
      };
    },
    async closeIssue(token, ref, comment) {
      const commented = await call('POST', `${issuePath(ref)}/comments`, token, { body: comment });
      if (commented.status !== 201) throw refused(`comment on ${ref}`, commented);
      const closed = await call('PATCH', issuePath(ref), token, { state: 'closed', state_reason: 'completed' });
      if (closed.status !== 200) throw refused(`close ${ref}`, closed);
    },
    async push(token, { clonePath, repo, branch }) {
      const refusal = pushRefusal(branch);
      if (refusal) throw new GitHubError(refusal);
      const url = `https://github.com/${repo}.git`;
      const git = (...args: string[]) => gitWithToken(clonePath, token, args);
      const tip = await git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`);
      const remoteTip = (await git('ls-remote', '--heads', url, `refs/heads/${branch}`)).split(/\s/, 1)[0] || null;
      if (remoteTip === tip) return { pushed: tip };
      // What GitHub has already is no change of this push's, as far as the clone knows it.
      const known = remoteTip && (await git('cat-file', '-t', remoteTip).catch(() => null)) === 'commit' ? [remoteTip] : [];
      const changed = await git('log', '--format=', '--name-only', '--no-renames', tip, '--not', '--remotes=origin', ...known);
      const paths = [...new Set(changed.split(/\r?\n/).filter(Boolean))].sort();
      const outside = outsideResearch(branch, paths);
      if (outside.length) return { outsideResearch: outside };
      const workflows = workflowFiles(paths);
      if (workflows.length) return { workflowFiles: workflows };
      // The tip checked, not whatever the branch points at by now.
      await git('push', '--no-verify', '--porcelain', url, `${tip}:refs/heads/${branch}`);
      return { pushed: tip };
    },
    async openDraftPr(token, { repo, head, base, title, body, assignee }) {
      const owner = repo.split('/')[0]!;
      const found = await call('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`, token);
      if (found.status !== 200) throw refused(`look for the PR of ${head}`, found);
      let pr = found.json[0];
      if (!pr) {
        let opened = await call('POST', `/repos/${repo}/pulls`, token, { title, head, base, body, draft: true });
        if (opened.status === 422 && draftsUnsupported(opened.json)) {
          opened = await call('POST', `/repos/${repo}/pulls`, token, { title, head, base, body, draft: false });
        }
        if (opened.status !== 201) throw refused(`open a draft PR of ${head}`, opened);
        pr = opened.json;
      }
      if (!(pr.assignees as { login: string }[]).some(({ login }) => login === assignee)) {
        const assigned = await call('POST', `/repos/${repo}/issues/${pr.number}/assignees`, token, { assignees: [assignee] });
        if (assigned.status !== 201) throw refused(`assign ${assignee} to #${pr.number}`, assigned);
      }
      return { number: pr.number, url: pr.html_url, draft: pr.draft === true };
    },
    async readPr(token, ref) {
      const pr = await pullRequest(token, ref);
      return { state: stateOf(pr), mergeable: mergeabilityOf(pr), head: String(pr.head.sha), draft: pr.draft === true };
    },
    async readChecks(token, repo, head) {
      const runs: any[] = [];
      for (let page = 1; ; page++) {
        const reply = await call('GET', `/repos/${repo}/commits/${head}/check-runs?per_page=100&page=${page}`, token);
        if (reply.status !== 200) throw refused(`read the check runs of ${head} in ${repo}`, reply);
        runs.push(...reply.json.check_runs);
        if (reply.json.check_runs.length < 100) break;
      }
      const status = await call('GET', `/repos/${repo}/commits/${head}/status?per_page=100`, token);
      if (status.status !== 200) throw refused(`read the commit statuses of ${head} in ${repo}`, status);
      return commitChecks(runs, status.json.statuses);
    },
    async markReady(token, ref) {
      const pr = await pullRequest(token, ref);
      if (pr.draft !== true) return;
      // REST has no way to leave draft: GraphQL's mutation does.
      const reply = await call('POST', '/graphql', token, {
        query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
        variables: { id: pr.node_id },
      });
      const errors = (reply.json?.errors as { message: string }[] | undefined) ?? [];
      if (reply.status !== 200 || errors.length) {
        throw new GitHubError(`GitHub refused to mark ${ref} ready (HTTP ${reply.status}${errors.length ? `: ${errors.map(({ message }) => message).join(': ')}` : ''}).`);
      }
    },
    async mergePr(token, ref, { method, head }) {
      if (stateOf(await pullRequest(token, ref)) === 'merged') return;
      const reply = await call('PUT', `${pullPath(ref)}/merge`, token, { merge_method: method, sha: head });
      if (reply.status !== 200) throw refused(`merge ${ref}`, reply);
    },
    async closePr(token, ref, comment) {
      if (stateOf(await pullRequest(token, ref)) !== 'open') return;
      const commented = await call('POST', `${issuePath(ref)}/comments`, token, { body: comment });
      if (commented.status !== 201) throw refused(`comment on ${ref}`, commented);
      const closed = await call('PATCH', pullPath(ref), token, { state: 'closed' });
      if (closed.status !== 200) throw refused(`close ${ref}`, closed);
    },
    async reopenPr(token, ref) {
      const head = (await pullRequest(token, ref)).head.ref as string;
      const [repo, number] = ref.split('#');
      const branch = await call('GET', `/repos/${repo}/git/ref/heads/${refPath(head)}`, token);
      if (branch.status === 404) throw new GitHubError(goneHead(head, number!));
      const reopened = await call('PATCH', pullPath(ref), token, { state: 'open' });
      if (reopened.status !== 200) throw refused(`reopen ${ref}`, reopened);
    },
    async deleteBranch(token, repo, branch) {
      const refusal = deleteRefusal(branch);
      if (refusal) throw new GitHubError(refusal);
      const reply = await call('DELETE', `/repos/${repo}/git/refs/heads/${refPath(branch)}`, token);
      // Deleted already, such as by GitHub's auto-delete; any other refusal is one.
      if (reply.status === 204 || (reply.status === 422 && /reference does not exist/i.test(reply.json?.message ?? ''))) return;
      throw refused(`delete ${branch} of ${repo}`, reply);
    },
    async appOwner(app) {
      const reply = await call('GET', '/app', appJwt(app));
      if (reply.status !== 200) throw refused('say who owns the App', reply);
      return reply.json.owner.login as string;
    },
  };
}

// Runs git in the clone as the App, with `token` and nothing of the
// operator's: no system or global config, so no credential helper, URL
// rewrite or hook path of theirs applies, and no prompt. The token travels
// in an environment-borne header, never in a command line or URL. Throws a
// `GitHubError` with what git said.
function gitWithToken(cwd: string, token: string, args: string[]): Promise<string> {
  const { GIT_ASKPASS, SSH_ASKPASS, GIT_CONFIG_PARAMETERS, ...env } = process.env;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: '1',
          // Git for Windows reads `/dev/null` as the null device too.
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: '',
          GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
        },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim());
        const said = [token, basic].reduce((text, secret) => text.split(secret).join('***'), `${stderr}`).trim() || error.message;
        reject(new GitHubError(`git ${args[0]} failed: ${said}`));
      },
    );
  });
}

// Whether GitHub refused a draft PR because the repository offers none, as a
// private one under GitHub Free: "Draft pull requests are not supported in
// this repository."
function draftsUnsupported(json: any): boolean {
  const said = [json?.message, ...((json?.errors as { message?: string }[] | undefined) ?? []).map((error) => error.message)];
  return said.some((message) => /draft pull requests are not supported/i.test(message ?? ''));
}

// Why a PR can't be reopened: GitHub no longer has its head branch.
export function goneHead(head: string, number: string | number): string {
  return `${head} is gone from GitHub, so #${number} can’t be reopened. Push it again first, or cancel the task.`;
}

// Where the PR stands, from GitHub's own account of it.
function stateOf(pr: { merged: boolean; state: string }): PrState {
  return pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed';
}

// Whether the PR is mergeable, as GitHub last worked it out: GitHub says
// null until it has.
function mergeabilityOf(pr: { mergeable?: boolean | null }): Mergeability {
  return pr.mergeable === true ? 'mergeable' : pr.mergeable === false ? 'conflicting' : 'unknown';
}

// The conclusions of a finished check run that let a PR through: skipped
// and neutral ones count as passing, as GitHub's own merge box counts them.
const PASSED = ['success', 'neutral', 'skipped'];

// A check run as the gate reads it: pending until it completes, then green
// when its conclusion passes, else red.
export function checkRunState({ status, conclusion }: { status: string; conclusion?: string | null }): ChecksState {
  if (status !== 'completed') return 'pending';
  return PASSED.includes(conclusion ?? '') ? 'green' : 'red';
}

// A commit status as the gate reads it: `success` green, `pending` pending,
// and `failure` or `error` red.
export function statusState(state: string): ChecksState {
  return state === 'success' ? 'green' : state === 'pending' ? 'pending' : 'red';
}

// The combined state of a commit's check runs and commit statuses, each
// list already read as green, red or pending: any red is red, else any
// pending is pending, else green, and with none at all, none.
export function combinedChecks(...lists: ChecksState[][]): ChecksState {
  const all = lists.flat();
  if (all.length === 0) return 'none';
  if (all.includes('red')) return 'red';
  return all.includes('pending') ? 'pending' : 'green';
}

// A commit's check runs and commit statuses, as GitHub's REST API lists
// them, read as the gate reads them: combined, with those that failed named,
// each with the page that says why.
export function commitChecks(
  runs: { name: string; status: string; conclusion?: string | null; html_url?: string | null; details_url?: string | null }[],
  statuses: { context: string; state: string; target_url?: string | null }[],
): Checks {
  const failedRuns = runs.filter((run) => checkRunState(run) === 'red').map((run) => ({ name: run.name, url: run.html_url ?? run.details_url ?? null }));
  const failedStatuses = statuses.filter(({ state }) => statusState(state) === 'red').map((status) => ({ name: status.context, url: status.target_url ?? null }));
  return { state: combinedChecks(runs.map(checkRunState), statuses.map(({ state }) => statusState(state))), failed: [...failedRuns, ...failedStatuses] };
}

// The REST path of a PR `owner/name#n`.
function pullPath(ref: string): string {
  const [repo, number] = ref.split('#');
  return `/repos/${repo}/pulls/${number}`;
}

// A branch name as a ref path, each segment escaped.
function refPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

// The REST path of an issue `owner/name#n`.
function issuePath(ref: string): string {
  const [repo, number] = ref.split('#');
  return `/repos/${repo}/issues/${number}`;
}

// The App's own JWT, valid for 9 minutes from a minute ago, which allows for
// clock drift (GitHub caps it at 10).
function appJwt({ id, privateKey }: FactoryApp): string {
  const seconds = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: seconds - 60, exp: seconds + 540, iss: String(id) })}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}
