import {
  GitHubError,
  deleteRefusal,
  goneHead,
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
  type Mergeability,
  type PrState,
  type PrStatus,
  type PullRequest,
} from '../github/github.ts';
import { outsideResearch } from '../github/research-branch.ts';
import type { FakeClock } from './fake-clock.ts';
import type { FakeGit } from './fake-git.ts';

// Installation tokens live an hour, as GitHub's do.
const TOKEN_LIFETIME_MS = 60 * 60_000;

type Minted = { repo: string; permissions: Permissions } & InstallationToken;

// A PR as GitHub has it, with the token that opened it, where it stands, and its comments.
type FakePullRequest = PullRequest & {
  repo: string;
  draft: boolean;
  head: string;
  base: string;
  title: string;
  body: string;
  assignees: string[];
  token: Minted;
  state: PrState;
  comments: string[];
  // What GitHub says of its mergeability as a test set it, if it did.
  mergeable?: Mergeability | null;
};

// The token as it was minted, kept with a write it made.
function snapshot(minted: Minted): Minted {
  return { ...minted, permissions: { ...minted.permissions } };
}

// Why an issue is in its state, as GitHub says: closed as completed, or reopened.
type StateReason = 'completed' | 'reopened' | null;

type FakeIssue = { title: string; open: boolean; stateReason: StateReason; labels: string[]; blockedBy: string[]; subIssues: string[]; comments: string[] };

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
  // Each PR closed or reopened through the port, with its token.
  readonly prWrites: { action: 'close' | 'reopen'; repo: string; number: number; token: Minted }[] = [];
  // Each branch deleted through the port, with its token.
  readonly branchDeletes: { repo: string; branch: string; token: Minted }[] = [];
  // The login of the account that owns every App: the operator's.
  readonly operator = 'octo-operator';
  private readonly codes = new Map<string, string>();
  private readonly apps = new Map<number, FactoryApp>();
  private readonly installed = new Set<string>();
  private readonly issues = new Map<string, FakeIssue>();
  private readonly noDrafts = new Set<string>();
  private failure: string | null = null;
  private prFailure: string | null = null;
  private issueWriteFailure: string | null = null;
  private hold: { arrived(): void; released: Promise<void> } | null = null;

  // `git` holds the clones pushes come from, whose origin is this GitHub.
  constructor(
    private readonly clock: FakeClock,
    private readonly git: FakeGit,
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

  // GitHub offers no draft PRs on `repo`, as on a private repository under
  // GitHub Free: PRs opened there are regular ones.
  offerNoDrafts(repo: string): void {
    this.noDrafts.add(repo);
  }

  // Opening PRs fails with `reason` from now on, or works again with null.
  failPullRequests(reason: string | null): void {
    this.prFailure = reason;
  }

  // Closing and reopening issues fails with `reason` from now on, or works again with null.
  failIssueWrites(reason: string | null): void {
    this.issueWriteFailure = reason;
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

  // An open issue (`owner/name#n`) titled `title`, with `labels`, added last
  // among the sub-issues of `parent`, and blocked by the issues `blockedBy`.
  addIssue(
    ref: string,
    { title = `Issue ${ref}`, parent, labels = [], blockedBy = [] }: { title?: string; parent?: string; labels?: string[]; blockedBy?: string[] } = {},
  ): void {
    this.issues.set(ref, { title, open: true, stateReason: null, labels: [...labels], blockedBy: [...blockedBy], subIssues: [], comments: [] });
    if (parent) this.issueAt(parent).subIssues.push(ref);
  }

  // The operator reorders the parent's sub-issues on GitHub.
  reorder(parent: string, subIssues: string[]): void {
    this.issueAt(parent).subIssues = [...subIssues];
  }

  // Someone marks the issue blocked by `blocker` on GitHub.
  block(ref: string, blocker: string): void {
    this.issueAt(ref).blockedBy.push(blocker);
  }

  // Someone relabels the issue on GitHub.
  relabel(ref: string, labels: string[]): void {
    this.issueAt(ref).labels = [...labels];
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
    const { title, open, labels, blockedBy } = this.found(ref);
    return { ref, title, open, labels: [...labels], openBlockers: blockedBy.filter((blocker) => this.issues.get(blocker)?.open) };
  }

  async closeIssue(token: string, ref: string, comment: string): Promise<void> {
    await this.held();
    if (this.issueWriteFailure) throw new GitHubError(this.issueWriteFailure);
    const minted = this.scoped(token, ref, 'issues', 'write');
    const issue = this.found(ref);
    issue.comments.push(comment);
    issue.open = false;
    issue.stateReason = 'completed';
    this.writes.push({ action: 'close', ref, comment, token: snapshot(minted) });
  }

  async reopenIssue(token: string, ref: string, comment: string): Promise<void> {
    await this.held();
    if (this.issueWriteFailure) throw new GitHubError(this.issueWriteFailure);
    const minted = this.scoped(token, ref, 'issues', 'write');
    const issue = this.found(ref);
    issue.comments.push(comment);
    issue.open = true;
    issue.stateReason = 'reopened';
    this.writes.push({ action: 'reopen', ref, comment, token: snapshot(minted) });
  }

  async push(token: string, { clonePath, repo, branch }: BranchPush): Promise<Pushed> {
    const refusal = pushRefusal(branch);
    if (refusal) throw new GitHubError(refusal);
    await this.held();
    const minted = this.scoped(token, repo, 'contents', 'write');
    const { git } = this;
    const tip = git.branchTip(clonePath, branch);
    if (!tip) throw new GitHubError(`error: src refspec ${branch} does not match any`);
    const remoteTip = git.originTip(clonePath, branch);
    if (remoteTip === tip) return { pushed: tip };
    const changed = git.outgoingChanges(clonePath, branch, remoteTip);
    const outside = outsideResearch(branch, changed);
    if (outside.length) return { outsideResearch: outside };
    const workflows = workflowFiles(changed);
    if (workflows.length) return { workflowFiles: workflows };
    git.push(clonePath, branch);
    this.pushes.push({ repo, branch, tip, token: snapshot(minted) });
    return { pushed: tip };
  }

  async openDraftPr(token: string, { repo, head, base, title, body, assignee }: DraftPr): Promise<PullRequest> {
    await this.held();
    if (this.prFailure) throw new GitHubError(this.prFailure);
    const minted = this.scoped(token, repo, 'pull_requests', 'write');
    // GitHub reads the branches with the same token.
    this.scoped(token, repo, 'contents', 'read');
    const open = this.pullRequests.find((pr) => pr.repo === repo && pr.head === head && pr.state === 'open');
    if (open) return { number: open.number, url: open.url, draft: open.draft };
    const number = 100 + this.pullRequests.length + 1;
    const url = `https://github.com/${repo}/pull/${number}`;
    const draft = !this.noDrafts.has(repo);
    const opener = snapshot(minted);
    this.pullRequests.push({ number, url, repo, draft, head, base, title, body, assignees: [assignee], token: opener, state: 'open', comments: [] });
    return { number, url, draft };
  }

  // Someone merges the PR on GitHub: the base branch takes its head.
  merge(number: number): void {
    const pr = this.prAt(number);
    pr.state = 'merged';
    this.git.mergeOnOrigin(pr.repo, pr.head, pr.base);
  }

  // Someone closes the PR on GitHub without merging it.
  closeUnmerged(number: number): void {
    this.prAt(number).state = 'closed';
  }

  // Someone reopens the PR on GitHub.
  reopen(number: number): void {
    this.prAt(number).state = 'open';
  }

  async readPr(token: string, ref: string): Promise<PrStatus> {
    this.scoped(token, ref, 'pull_requests', 'read');
    const pr = this.foundPr(ref);
    return { state: pr.state, mergeable: pr.state === 'open' ? this.mergeabilityOf(pr) : 'unknown' };
  }

  // Whether GitHub finds the open PR mergeable: as a test set it, or as its
  // branches on origin merge.
  private mergeabilityOf(pr: FakePullRequest): Mergeability {
    return pr.mergeable ?? (this.git.conflictsOnOrigin(pr.repo, pr.head, pr.base) ? 'conflicting' : 'mergeable');
  }

  // GitHub finds the PR `mergeable` from now on, whatever its branches, or
  // works it out from them again with null.
  setMergeable(number: number, mergeable: Mergeability | null): void {
    this.prAt(number).mergeable = mergeable;
  }

  async closePr(token: string, ref: string, comment: string): Promise<void> {
    await this.held();
    const minted = this.scoped(token, ref, 'pull_requests', 'write');
    const pr = this.foundPr(ref);
    if (pr.state !== 'open') return;
    pr.comments.push(comment);
    pr.state = 'closed';
    this.prWrites.push({ action: 'close', repo: pr.repo, number: pr.number, token: snapshot(minted) });
  }

  async reopenPr(token: string, ref: string): Promise<void> {
    await this.held();
    const minted = this.scoped(token, ref, 'pull_requests', 'write');
    const pr = this.foundPr(ref);
    if (!this.git.onOrigin(pr.repo, pr.head)) throw new GitHubError(goneHead(pr.head, pr.number));
    if (pr.state === 'merged') throw new GitHubError('GitHub refused to reopen a merged PR (HTTP 422: Validation Failed).');
    pr.state = 'open';
    this.prWrites.push({ action: 'reopen', repo: pr.repo, number: pr.number, token: snapshot(minted) });
  }

  async deleteBranch(token: string, repo: string, branch: string): Promise<void> {
    const refusal = deleteRefusal(branch);
    if (refusal) throw new GitHubError(refusal);
    await this.held();
    const minted = this.scoped(token, repo, 'contents', 'write');
    this.git.deleteOnOrigin(repo, branch);
    this.branchDeletes.push({ repo, branch, token: snapshot(minted) });
  }

  // The PR as GitHub has it now.
  prState(number: number): { state: PrState; comments: string[] } {
    const { state, comments } = this.prAt(number);
    return { state, comments: [...comments] };
  }

  // The PR a test names: one it never opened is the test's mistake.
  private prAt(number: number): FakePullRequest {
    const pr = this.pullRequests.find((pr) => pr.number === number);
    if (!pr) throw new Error(`There is no PR #${number}.`);
    return pr;
  }

  // The PR a call names, which GitHub doesn't find unless it has it.
  private foundPr(ref: string): FakePullRequest {
    const pr = this.pullRequests.find((pr) => `${pr.repo}#${pr.number}` === ref);
    if (!pr) throw new GitHubError('GitHub refused the call (HTTP 404: Not Found).');
    return pr;
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
