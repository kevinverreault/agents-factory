// The GitHub port (ADR 0004): what the factory asks GitHub as its factory
// identity, a GitHub App. It turns the manifest flow's code into the App,
// says whether the App is installed on a repository, and mints installation
// tokens narrowed to one repository and the permissions asked for. With such
// a token it reads the Ralph loop's tickets, closes them, and reopens them
// when their task is cancelled (ADR 0006), pushes task branches, and opens
// their draft PRs. The REST adapter (`gitHubApi`) is the real one.
import { execFile } from 'node:child_process';
import { sign } from 'node:crypto';
import { issueRef } from '../artifacts/capture.ts';

// The factory identity's App as the daemon keeps it, private key included, in
// the credential store.
export type FactoryApp = { id: number; slug: string; privateKey: string };

export type Permission = 'contents' | 'issues' | 'pull_requests' | 'metadata';
export type Permissions = Partial<Record<Permission, 'read' | 'write'>>;

// What an AFK run reads GitHub with: Issues, Pull requests and Metadata read.
export const READ_ONLY: Permissions = { issues: 'read', pull_requests: 'read', metadata: 'read' };

// What closing a ticket, or reopening it, writes with: a comment and the issue's state.
export const TICKET_WRITE: Permissions = { issues: 'write', metadata: 'read' };

// What pushing a task branch writes with: the repository's contents alone.
export const PUSH: Permissions = { contents: 'write', metadata: 'read' };

// What opening a PR, and assigning it, writes with: pull requests alone.
export const OPEN_PR: Permissions = { pull_requests: 'write', metadata: 'read' };

export type InstallationToken = { token: string; expiresAt: number };

// What the factory pushes (ADR 0004): the task branch of the clone at
// `clonePath`, to the branch of the same name in the repository `repo`.
export type BranchPush = { clonePath: string; repo: string; branch: string };
// The tip GitHub has of the branch once pushed, or, unpushed, the workflow
// files its commits change: the App has no Workflows permission, so the
// operator pushes those by hand (ADR 0004).
export type Pushed = { pushed: string } | { workflowFiles: string[] };

// A draft PR the factory opens (ADR 0004): of the pushed task branch `head`
// into `base`, assigned to `assignee`, the operator.
export type DraftPr = { repo: string; head: string; base: string; title: string; body: string; assignee: string };
export type PullRequest = { number: number; url: string };

// Those of `paths` (from the top, with `/`) that are workflow files.
export function workflowFiles(paths: string[]): string[] {
  return paths.filter((path) => path.startsWith('.github/workflows/'));
}

// An issue (`owner/name#n`) as the Ralph loop reads it: whether it is open,
// its labels, and the open issues blocking it (GitHub's native dependencies).
export type Issue = { ref: string; open: boolean; labels: string[]; openBlockers: string[] };

export interface GitHub {
  // The App GitHub created from the factory's manifest, by the code its
  // redirect carried back (valid for an hour).
  createApp(code: string): Promise<FactoryApp>;
  // Whether the App is installed on the repository (`owner/name`).
  isInstalled(app: FactoryApp, repo: string): Promise<boolean>;
  // A token of the App's installation on the repository, for that repository
  // alone and with those permissions alone.
  mintToken(app: FactoryApp, repo: string, permissions: Permissions): Promise<InstallationToken>;
  // The issue's sub-issues, in their order on GitHub, read with `token`.
  subIssues(token: string, ref: string): Promise<string[]>;
  readIssue(token: string, ref: string): Promise<Issue>;
  // Comments `comment` on the issue, then closes it as completed, with
  // `token`, which needs Issues write.
  closeIssue(token: string, ref: string, comment: string): Promise<void>;
  // Comments `comment` on the issue, then reopens it, with `token`, which
  // needs Issues write.
  reopenIssue(token: string, ref: string, comment: string): Promise<void>;
  // Pushes the task branch with `token`, which needs Contents write, under a
  // fixed refspec: the branch's tip to the same branch on GitHub, never
  // forced, and with no hooks run. A branch GitHub already has at that tip,
  // such as one the operator pushed by hand, is pushed already. Otherwise a
  // branch whose commits GitHub doesn't have change workflow files isn't
  // pushed. Throws a `GitHubError` when the refspec guard or GitHub refuses it.
  push(token: string, push: BranchPush): Promise<Pushed>;
  // Opens the draft PR with `token`, which needs Pull requests write, and
  // assigns it; or finds the open PR of its head branch, as when the factory
  // stopped before it could record that it opened it.
  openDraftPr(token: string, pr: DraftPr): Promise<PullRequest>;
  // The login of the account that owns the App: the operator's, whose
  // account `setup github` created it on.
  appOwner(app: FactoryApp): Promise<string>;
}

// GitHub couldn't be reached, or refused, saying why.
export class GitHubError extends Error {}

// The refspec guard (ADR 0004): the factory pushes task branches
// (`factory/<id>-<slug>`) and nothing else, so a token that could write any
// branch never writes the base branch. Why `branch` can't be pushed, or null.
export function pushRefusal(branch: string): string | null {
  return /^factory\/[\w.-]+$/.test(branch) ? null : `The factory pushes only task branches (factory/…), not ${branch}.`;
}

// Where the operator installs the App, or changes which repositories an
// installation covers.
export function installationSettings(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}

// The App's permissions (ADR 0004): no Workflows, Actions, Checks or Administration.
export const APP_PERMISSIONS: Permissions = { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' };

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

  const refused = (what: string, { status, json }: { status: number; json: any }) =>
    new GitHubError(`GitHub refused to ${what} (HTTP ${status}${json?.message ? `: ${json.message}` : ''}).`);

  // The installation covering the repository, or null when there is none.
  async function installationOf(app: FactoryApp, repo: string): Promise<number | null> {
    const reply = await call('GET', `/repos/${repo}/installation`, appJwt(app));
    if (reply.status === 404) return null;
    if (reply.status !== 200) throw refused(`say whether the App is installed on ${repo}`, reply);
    return reply.json.id as number;
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
    async isInstalled(app, repo) {
      return (await installationOf(app, repo)) !== null;
    },
    async mintToken(app, repo, permissions) {
      const installation = await installationOf(app, repo);
      if (installation === null) throw new GitHubError(`The factory’s App isn’t installed on ${repo}.`);
      const reply = await call('POST', `/app/installations/${installation}/access_tokens`, appJwt(app), {
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
    async reopenIssue(token, ref, comment) {
      const commented = await call('POST', `${issuePath(ref)}/comments`, token, { body: comment });
      if (commented.status !== 201) throw refused(`comment on ${ref}`, commented);
      const reopened = await call('PATCH', issuePath(ref), token, { state: 'open', state_reason: 'reopened' });
      if (reopened.status !== 200) throw refused(`reopen ${ref}`, reopened);
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
      const workflows = workflowFiles([...new Set(changed.split(/\r?\n/).filter(Boolean))].sort());
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
        const opened = await call('POST', `/repos/${repo}/pulls`, token, { title, head, base, body, draft: true });
        if (opened.status !== 201) throw refused(`open a draft PR of ${head}`, opened);
        pr = opened.json;
      }
      if (!(pr.assignees as { login: string }[]).some(({ login }) => login === assignee)) {
        const assigned = await call('POST', `/repos/${repo}/issues/${pr.number}/assignees`, token, { assignees: [assignee] });
        if (assigned.status !== 201) throw refused(`assign ${assignee} to #${pr.number}`, assigned);
      }
      return { number: pr.number, url: pr.html_url };
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
        const said = `${stderr}`.split(token).join('***').trim() || error.message;
        reject(new GitHubError(`git ${args[0]} failed: ${said}`));
      },
    );
  });
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
