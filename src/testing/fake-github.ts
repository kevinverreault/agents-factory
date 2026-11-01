import { GitHubError, type FactoryApp, type GitHub, type InstallationToken, type Permissions } from '../github/github.ts';
import type { FakeClock } from './fake-clock.ts';

// Installation tokens live an hour, as GitHub's do.
const TOKEN_LIFETIME_MS = 60 * 60_000;

// GitHub as the factory identity sees it: Apps created from manifest codes,
// the repositories each is installed on, and a record of every token minted
// with its scope. A test can make it unreachable.
export class FakeGitHub implements GitHub {
  readonly minted: ({ repo: string; permissions: Permissions } & InstallationToken)[] = [];
  private readonly codes = new Map<string, string>();
  private readonly apps = new Map<number, FactoryApp>();
  private readonly installed = new Set<string>();
  private failure: string | null = null;

  constructor(private readonly clock: FakeClock) {}

  // The code GitHub's redirect carries back once the operator creates an App
  // named `slug` from the manifest.
  manifestCode(slug = 'agents-factory-operator'): string {
    const code = `code-${this.codes.size + 1}`;
    this.codes.set(code, slug);
    return code;
  }

  // The operator installs the App on `repo`.
  install(repo: string): void {
    this.installed.add(repo);
  }

  // Every call fails with `reason` from now on, or works again with null.
  unreachable(reason: string | null): void {
    this.failure = reason;
  }

  async createApp(code: string): Promise<FactoryApp> {
    this.reach();
    const slug = this.codes.get(code);
    if (!slug) throw new GitHubError('GitHub refused to create the App from its manifest (HTTP 404: Not Found).');
    this.codes.delete(code);
    const id = 1000 + this.apps.size + 1;
    const app = { id, slug, privateKey: `-----BEGIN RSA PRIVATE KEY-----\nfake key of App ${id}\n-----END RSA PRIVATE KEY-----\n` };
    this.apps.set(id, app);
    return { ...app };
  }

  async isInstalled(app: FactoryApp, repo: string): Promise<boolean> {
    this.authenticate(app);
    return this.installed.has(repo);
  }

  async mintToken(app: FactoryApp, repo: string, permissions: Permissions): Promise<InstallationToken> {
    this.authenticate(app);
    if (!this.installed.has(repo)) throw new GitHubError(`The factory’s App isn’t installed on ${repo}.`);
    const token = { token: `ghs_fake${this.minted.length + 1}`, expiresAt: this.clock.now() + TOKEN_LIFETIME_MS };
    this.minted.push({ repo, permissions: { ...permissions }, ...token });
    return { ...token };
  }

  private reach(): void {
    if (this.failure) throw new GitHubError(this.failure);
  }

  // An App's JWT holds only if it is signed with the key GitHub issued it.
  private authenticate(app: FactoryApp): void {
    this.reach();
    if (this.apps.get(app.id)?.privateKey !== app.privateKey) throw new GitHubError('GitHub refused the App’s JWT (HTTP 401: Bad credentials).');
  }
}
