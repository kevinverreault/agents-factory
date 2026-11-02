import {
  GitHubError,
  pushRefusal,
  workflowFiles,
  type BranchPush,
  type FactoryApp,
  type GitHub,
  type InstallationToken,
  type Issue,
  type Permissions,
  type Pushed,
  type DraftPr,
  type PullRequest,
} from '../github/github.ts';
import type { FakeClock } from './fake-clock.ts';
import type { FakeGit } from './fake-git.ts';

// Installation tokens live an hour, as GitHub's do.
const TOKEN_LIFETIME_MS = 60 * 60_000;

type Minted = { repo: string; permissions: Permissions } & InstallationToken;

// A PR as GitHub has it, with the token that opened it.
type FakePullRequest = PullRequest & { repo: string; draft: boolean; head: string; base: string; title: string; body: string; assignees: string[]; token: Minted };

// Why an issue is in its state, as GitHub says: closed as completed, or reopened.
type StateReason = 'completed' | 'reopened' | null;

type FakeIssue = { open: boolean; stateReason: StateReason; labels: string[]; blockedBy: string[]; subIssues: string[]; comments: string[] };

// GitHub as the factory identity sees it: Apps created from manifest codes,
// the repositories each is installed on, a record of every token minted with
// its scope, and issues with their sub-issues and native dependencies, with a
// record of each write and the scope of the token it was made with. A test
// can make it unreachable, or hold its writes mid-call.
export class FakeGitHub implements GitHub {
  readonly minted: Minted[] = [];
  readonly writes: { action: 'close' | 'reopen'; ref: string; comment: string; token: Minted }[] = [];
  // Each push that reached GitHub, with the tip it sent and its token.
  readonly pushes: { repo: string; branch: string; tip: string; token: Minted }[] = [];
  // Every PR opened, in order.
  readonly pullRequests: FakePullRequest[] = [];
  // The login of the account that owns every App: the operator's.
  readonly operator = 'octo-operator';
  private readonly codes = new Map<string, string>();
  private readonly apps = new Map<number, FactoryApp>();
  private readonly installed = new Set<string>();
  private readonly issues = new Map<string, FakeIssue>();
  private failure: string | null = null;
  private readonly failures = new Map<'openDraftPr', string>();
  private hold: { arrived(): void; released: Promise<void> } | null = null;

  // `git` holds the clones pushes come from, whose origin is this GitHub.
  constructor(
    private readonly clock: FakeClock,
    private readonly git?: FakeGit,
  ) {}

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

  // Opening PRs fails with `reason` from now on, or works again with null.
  unreachableFor(call: 'openDraftPr', reason: string | null): void {
    if (reason === null) this.failures.delete(call);
    else this.failures.set(call, reason);
  }

  // The writes from now on wait, unmade, until `release`: `held` settles
  // once the first of them arrives.
  holdWrites(): { held: Promise<void>; release(): void } {
    const held = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    this.hold = { arrived: held.resolve, released: released.promise };
    return {
      held: held.promise,
      release: () => {
        this.hold = null;
        released.resolve();
      },
    };
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
  issueState(ref: string): { open: boolean; stateReason: StateReason; comments: string[] } {
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

  async appOwner(app: FactoryApp): Promise<string> {
    this.authenticate(app);
    return this.operator;
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
    await this.held();
    const minted = this.scoped(token, ref, 'issues', 'write');
    const issue = this.found(ref);
    issue.comments.push(comment);
    issue.open = false;
    issue.stateReason = 'completed';
    this.writes.push({ action: 'close', ref, comment, token: { ...minted, permissions: { ...minted.permissions } } });
  }

  async reopenIssue(token: string, ref: string, comment: string): Promise<void> {
    await this.held();
    const minted = this.scoped(token, ref, 'issues', 'write');
    const issue = this.found(ref);
    issue.comments.push(comment);
    issue.open = true;
    issue.stateReason = 'reopened';
    this.writes.push({ action: 'reopen', ref, comment, token: { ...minted, permissions: { ...minted.permissions } } });
  }

  async push(token: string, { clonePath, repo, branch }: BranchPush): Promise<Pushed> {
    const refusal = pushRefusal(branch);
    if (refusal) throw new GitHubError(refusal);
    await this.held();
    const minted = this.scoped(token, repo, 'contents', 'write');
    const git = this.clones();
    const tip = git.branchTip(clonePath, branch);
    if (!tip) throw new GitHubError(`error: src refspec ${branch} does not match any`);
    const remoteTip = git.originTip(clonePath, branch);
    if (remoteTip === tip) return { pushed: tip };
    const workflows = workflowFiles(git.outgoingChanges(clonePath, branch, remoteTip));
    if (workflows.length) return { workflowFiles: workflows };
    git.push(clonePath, branch);
    this.pushes.push({ repo, branch, tip, token: { ...minted, permissions: { ...minted.permissions } } });
    return { pushed: tip };
  }

  async openDraftPr(token: string, { repo, head, base, title, body, assignee }: DraftPr): Promise<PullRequest> {
    await this.held();
    const failure = this.failures.get('openDraftPr');
    if (failure) throw new GitHubError(failure);
    const minted = this.scoped(token, repo, 'pull_requests', 'write');
    const open = this.pullRequests.find((pr) => pr.repo === repo && pr.head === head);
    if (open) return { number: open.number, url: open.url };
    const number = 100 + this.pullRequests.length + 1;
    const url = `https://github.com/${repo}/pull/${number}`;
    const opener = { ...minted, permissions: { ...minted.permissions } };
    this.pullRequests.push({ number, url, repo, draft: true, head, base, title, body, assignees: [assignee], token: opener });
    return { number, url };
  }

  private clones(): FakeGit {
    if (!this.git) throw new Error('This fake GitHub has no clones to push from.');
    return this.git;
  }

  // Waits while writes are held.
  private async held(): Promise<void> {
    if (!this.hold) return;
    this.hold.arrived();
    await this.hold.released;
  }

  private reach(): void {
    if (this.failure) throw new GitHubError(this.failure);
  }

  // An App's JWT holds only if it is signed with the key GitHub issued it.
  private authenticate(app: FactoryApp): void {
    this.reach();
    if (this.apps.get(app.id)?.privateKey !== app.privateKey) throw new GitHubError('GitHub refused the App’s JWT (HTTP 401: Bad credentials).');
  }

  // The live token minted as `token`, which must cover the repository (or
  // the issue's, for an issue ref) with `level` on `permission`.
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
