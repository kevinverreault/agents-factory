import { GitHubError, type FactoryApp, type GitHub, type InstallationToken, type Issue, type Permissions } from '../github/github.ts';
import type { FakeClock } from './fake-clock.ts';

// Installation tokens live an hour, as GitHub's do.
const TOKEN_LIFETIME_MS = 60 * 60_000;

type Minted = { repo: string; permissions: Permissions } & InstallationToken;

type FakeIssue = { open: boolean; stateReason: 'completed' | null; labels: string[]; blockedBy: string[]; subIssues: string[]; comments: string[] };

// GitHub as the factory identity sees it: Apps created from manifest codes,
// the repositories each is installed on, a record of every token minted with
// its scope, and issues with their sub-issues and native dependencies, with a
// record of each write and the scope of the token it was made with. A test
// can make it unreachable.
export class FakeGitHub implements GitHub {
  readonly minted: Minted[] = [];
  readonly writes: { action: 'close'; ref: string; comment: string; token: Minted }[] = [];
  private readonly codes = new Map<string, string>();
  private readonly apps = new Map<number, FactoryApp>();
  private readonly installed = new Set<string>();
  private readonly issues = new Map<string, FakeIssue>();
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

  // The operator removes `repo` from the App's installation.
  uninstall(repo: string): void {
    this.installed.delete(repo);
  }

  // Every call fails with `reason` from now on, or works again with null.
  unreachable(reason: string | null): void {
    this.failure = reason;
  }

  // An open issue (`owner/name#n`) with `labels`, added last among the
  // sub-issues of `parent`, and blocked by the issues `blockedBy`.
  addIssue(ref: string, { parent, labels = [], blockedBy = [] }: { parent?: string; labels?: string[]; blockedBy?: string[] } = {}): void {
    this.issues.set(ref, { open: true, stateReason: null, labels: [...labels], blockedBy: [...blockedBy], subIssues: [], comments: [] });
    if (parent) this.issueAt(parent).subIssues.push(ref);
  }

  // The operator reorders the parent's sub-issues on GitHub.
  reorder(parent: string, subIssues: string[]): void {
    this.issueAt(parent).subIssues = [...subIssues];
  }

  // Someone closes the issue on GitHub.
  close(ref: string): void {
    this.issueAt(ref).open = false;
  }

  // The issue as GitHub has it now.
  issueState(ref: string): { open: boolean; stateReason: 'completed' | null; comments: string[] } {
    const { open, stateReason, comments } = this.issueAt(ref);
    return { open, stateReason, comments: [...comments] };
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

  async subIssues(token: string, ref: string): Promise<string[]> {
    this.scoped(token, ref, 'issues', 'read');
    return [...this.found(ref).subIssues];
  }

  async readIssue(token: string, ref: string): Promise<Issue> {
    this.scoped(token, ref, 'issues', 'read');
    const { open, labels, blockedBy } = this.found(ref);
    return { ref, open, labels: [...labels], openBlockers: blockedBy.filter((blocker) => this.issues.get(blocker)?.open) };
  }

  async closeIssue(token: string, ref: string, comment: string): Promise<void> {
    const minted = this.scoped(token, ref, 'issues', 'write');
    const issue = this.found(ref);
    issue.comments.push(comment);
    issue.open = false;
    issue.stateReason = 'completed';
    this.writes.push({ action: 'close', ref, comment, token: { ...minted, permissions: { ...minted.permissions } } });
  }

  private reach(): void {
    if (this.failure) throw new GitHubError(this.failure);
  }

  // An App's JWT holds only if it is signed with the key GitHub issued it.
  private authenticate(app: FactoryApp): void {
    this.reach();
    if (this.apps.get(app.id)?.privateKey !== app.privateKey) throw new GitHubError('GitHub refused the App’s JWT (HTTP 401: Bad credentials).');
  }

  // The live token minted as `token`, which must cover the issue's
  // repository with `level` on `permission`.
  private scoped(token: string, ref: string, permission: keyof Permissions, level: 'read' | 'write'): Minted {
    this.reach();
    const minted = this.minted.find((minted) => minted.token === token);
    if (!minted || minted.expiresAt <= this.clock.now()) throw new GitHubError('GitHub refused the token (HTTP 401: Bad credentials).');
    const granted = minted.permissions[permission];
    if (minted.repo !== ref.split('#')[0] || !granted || (level === 'write' && granted !== 'write')) {
      throw new GitHubError('GitHub refused the call (HTTP 403: Resource not accessible by integration).');
    }
    return minted;
  }

  private found(ref: string): FakeIssue {
    const issue = this.issues.get(ref);
    if (!issue) throw new GitHubError('GitHub refused the call (HTTP 404: Not Found).');
    return issue;
  }

  private issueAt(ref: string): FakeIssue {
    const issue = this.issues.get(ref);
    if (!issue) throw new Error(`There is no issue ${ref}.`);
    return issue;
  }
}
