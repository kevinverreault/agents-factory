// The GitHub port (ADR 0004): what the factory asks GitHub as its factory
// identity, a GitHub App. It turns the manifest flow's code into the App,
// says whether the App is installed on a repository, and mints installation
// tokens narrowed to one repository and the permissions asked for. The REST
// adapter (`gitHubApi`) is the real one.
import { sign } from 'node:crypto';

// The factory identity's App as the daemon keeps it, private key included, in
// the credential store.
export type FactoryApp = { id: number; slug: string; privateKey: string };

export type Permission = 'contents' | 'issues' | 'pull_requests' | 'metadata';
export type Permissions = Partial<Record<Permission, 'read' | 'write'>>;

// What an AFK run reads GitHub with: Issues, Pull requests and Metadata read.
export const READ_ONLY: Permissions = { issues: 'read', pull_requests: 'read', metadata: 'read' };

export type InstallationToken = { token: string; expiresAt: number };

export interface GitHub {
  // The App GitHub created from the factory's manifest, by the code its
  // redirect carried back (valid for an hour).
  createApp(code: string): Promise<FactoryApp>;
  // Whether the App is installed on the repository (`owner/name`).
  isInstalled(app: FactoryApp, repo: string): Promise<boolean>;
  // A token of the App's installation on the repository, for that repository
  // alone and with those permissions alone.
  mintToken(app: FactoryApp, repo: string, permissions: Permissions): Promise<InstallationToken>;
}

// GitHub couldn't be reached, or refused, saying why.
export class GitHubError extends Error {}

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
  };
}

// The App's own JWT, valid for 9 minutes from a minute ago, which allows for
// clock drift (GitHub caps it at 10).
function appJwt({ id, privateKey }: FactoryApp): string {
  const seconds = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: seconds - 60, exp: seconds + 540, iss: String(id) })}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}
