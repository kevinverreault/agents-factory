// A made-up factory for the README's media and `npm run demo`: the acme
// repositories, tasks in every state, a live HITL conversation and an AFK
// run with output, and what Needs you holds. No daemon, GitHub or Claude
// behind it: a FakeConnection serves the state, and each run's conversation
// to whoever opens or follows it.
import type { ConversationEvent } from '../executor/executor.ts';
import type { ConversationListener } from '../protocol/client.ts';
import type { FactoryState, RepositoryView, RunView, TaskView } from '../protocol/factory-state.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeConnection } from '../testing/fake-connection.ts';

// Where the demo's TUI starts: inside the widgets clone.
export const DEMO_CWD = '/clones/widgets';

// Every time the demo shows comes from the fake clock's start, never the
// machine's: re-recording draws the same frames.
const NOW = new FakeClock().now();
const MINUTE = 60_000;

const widgets: RepositoryView = { id: 'acme/widgets', path: DEMO_CWD, baseBranch: 'main', defaultPreset: 'main-flow', missing: false, app: null, skills: null };
const gadgets: RepositoryView = { ...widgets, id: 'acme/gadgets', path: '/clones/gadgets' };

function task(id: string, title: string, state: TaskView['state'], label: string, more: Partial<TaskView> = {}): TaskView {
  const mode = more.mode ?? 'AFK';
  return {
    id, title, repo: 'acme/widgets', parent: null, depth: 0, child: null, progress: null, rollup: null, mode, autonomy: mode === 'AFK' ? 'L1' : null,
    priority: 'normal', groups: [], state, label, liveRunId: null, branch: null, worktree: null, sessionId: null, skillSet: null, preset: null, stage: null,
    tier: 'sonnet', allowRules: [], egressHosts: [], goal: null, handoff: null, quick: null, closedTickets: [], skippedTickets: [], loop: null, reopening: null,
    prBody: null, publishing: null, pr: null, pushed: false, cleanup: null, transcripts: null,
    ...more,
  };
}

const usage = (input: number, output: number, cacheRead: number, cost: number) => ({ input, output, cacheRead, cacheWrite: 0, cost });

function run(id: string, taskId: string, more: Partial<RunView> = {}): RunView {
  return {
    id, taskId, mode: 'AFK', autonomy: 'L1', status: 'active', outcome: null, interruption: null, turn: 'agent', queued: [], question: null, permission: null,
    stage: 'implement', ticket: null, proposal: null, tier: 'sonnet', model: 'claude-sonnet-5-5', maxTurns: 300, cli: { pid: 4242, createdAt: NOW }, skillSet: null,
    startedAt: NOW - 30 * MINUTE, endedAt: null, usage: {}, deniedHosts: [], waitingForWindow: null,
    ...more,
  };
}

const hitlStage = (id: string, more: object = {}) => ({ id, kind: 'run' as const, skill: id, mode: 'HITL' as const, model: 'opus' as const, ...more });
// The built-in main flow, as a launched task freezes it.
const mainFlow: NonNullable<TaskView['preset']> = {
  name: 'main-flow',
  description: 'Grill, settle the glossary and spec, cut tickets, then implement and review unattended.',
  source: 'built-in',
  path: 'src/presets/built-in/main-flow.preset.yaml',
  hash: '0123456789abcdef',
  repoCommit: 'c0ffee',
  stages: [
    hitlStage('grill'),
    hitlStage('glossary', { optional: true }),
    hitlStage('spec', { optional: true, exit: 'artifact:spec' }),
    hitlStage('tickets'),
    { id: 'implement', kind: 'loop' as const, skill: 'implement', mode: 'AFK' as const, model: 'sonnet' as const },
  ],
};

// T1, the HITL conversation the media open: grilling on the main flow.
export const CONVERSING: TaskView = task('T1', 'Retry failed webhook deliveries', 'running', 'In conversation', {
  mode: 'HITL',
  liveRunId: 'R1',
  branch: 'factory/T1-retry-failed-webhook-deliveries',
  worktree: '/worktrees/acme-widgets/T1',
  sessionId: '5f0c2a8e-3b1d-4c6e-9a7f-2d8b4e1c0a93',
  preset: mainFlow,
  stage: 'grill',
  tier: 'opus',
  groups: ['webhooks'],
});
export const GRILLING: RunView = run('R1', 'T1', { mode: 'HITL', autonomy: null, stage: 'grill', tier: 'opus', model: 'claude-opus-5-5', maxTurns: null, turn: 'operator', startedAt: NOW - 12 * MINUTE, usage: { 'claude-opus-5-5': usage(48_200, 6_100, 310_000, 2.41) } });

// T2's run, live, whose output the Tasks screen shows under the tree.
const implementing = run('R2', 'T2', { ticket: 'acme/widgets#31', usage: { 'claude-sonnet-5-5': usage(122_000, 18_400, 1_900_000, 1.86) } });

// T5 asks which identity provider times out.
export const QUESTION = {
  id: 'toolu_01',
  questions: [
    {
      question: 'Which identity provider times out on Safari?',
      header: 'IdP',
      options: [
        { label: 'Okta', description: 'The workforce SSO' },
        { label: 'Auth0', description: 'The customer login' },
      ],
      multiSelect: false,
    },
  ],
};

export function demoState(): FactoryState {
  const tasks: TaskView[] = [
    CONVERSING,
    task('T2', 'Add a status --json flag', 'running', 'Running', {
      liveRunId: 'R2',
      branch: 'factory/T2-add-a-status-json-flag',
      stage: 'implement',
      progress: 'Writing the JSON formatter.',
      rollup: { done: 1, running: 1, needsYou: 0, cancelled: 0, failed: [] },
      loop: { ticket: 'acme/widgets#31', finishing: false, frontier: null, cleared: false },
      groups: ['cli'],
    }),
    task('T3', 'Format the table as JSON', 'done', 'Done', { parent: 'T2', depth: 1, groups: ['cli'] }),
    task('T4', 'Document the --json output', 'running', 'Running', { parent: 'T2', depth: 1, tier: 'haiku', liveRunId: 'R4', groups: ['cli', 'docs'] }),
    task('T5', 'Fix the login timeout on Safari', 'waiting', 'Needs you', { liveRunId: 'R5', groups: ['login'] }),
    task('T6', 'Add a logout button', 'in-review', 'In review', { groups: ['login'] }),
    task('T7', 'Settle the billing glossary', 'queued', 'Ready for you', { mode: 'HITL', groups: ['docs'] }),
    task('T8', 'Migrate the settings page', 'queued', 'Queued', { repo: 'acme/gadgets', autonomy: 'L2' }),
    task('T9', 'Bump CI to Node 24', 'done', 'Done', { groups: ['ci'] }),
  ];
  return {
    repositories: { 'acme/gadgets': gadgets, 'acme/widgets': widgets },
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    runs: {
      R1: GRILLING,
      R2: implementing,
      R3: run('R3', 'T3', { status: 'ended', outcome: 'completed', ticket: 'acme/widgets#30', startedAt: NOW - 70 * MINUTE, endedAt: NOW - 40 * MINUTE, usage: { 'claude-sonnet-5-5': usage(96_000, 12_000, 1_200_000, 1.12) } }),
      R4: run('R4', 'T4', { stage: null, tier: 'haiku', model: 'claude-haiku-5-5', startedAt: NOW - 8 * MINUTE, usage: { 'claude-haiku-5-5': usage(21_000, 3_200, 140_000, 0.09) } }),
      R5: run('R5', 'T5', { question: QUESTION, startedAt: NOW - 25 * MINUTE, usage: { 'claude-sonnet-5-5': usage(64_000, 7_000, 800_000, 0.74) } }),
      R6: run('R6', 'T6', { status: 'ended', outcome: 'completed', startedAt: NOW - 3 * 60 * MINUTE, endedAt: NOW - 2 * 60 * MINUTE, usage: { 'claude-sonnet-5-5': usage(150_000, 21_000, 2_400_000, 2.05) } }),
      R9: run('R9', 'T9', { status: 'ended', outcome: 'completed', tier: 'haiku', model: 'claude-haiku-5-5', startedAt: NOW - 5 * 60 * MINUTE, endedAt: NOW - 4 * 60 * MINUTE, usage: { 'claude-haiku-5-5': usage(12_000, 1_400, 90_000, 0.04) } }),
    },
    artifacts: {
      X1: { id: 'X1', taskId: 'T1', runId: 'R1', kind: 'file', path: 'GLOSSARY.md', committed: false },
      X2: { id: 'X2', taskId: 'T1', runId: 'R1', kind: 'issue', url: 'https://github.com/acme/widgets/issues/27' },
      X3: { id: 'X3', taskId: 'T2', runId: 'R2', kind: 'file', path: 'src/status/json.ts', committed: true },
    },
    attentionQueue: [
      {
        kind: 'attention', taskId: 'T5', repo: 'acme/widgets', requestId: 'A1', attention: 'question', holdsRun: true,
        reason: 'Which identity provider times out on Safari?', question: QUESTION, permission: null, recovery: null, deniedHosts: null,
      },
      { kind: 'review', taskId: 'T6' },
      { kind: 'ready', taskId: 'T7' },
    ],
    slots: { active: 2, cap: 3 },
    keepAwake: true,
    lastUsedRepo: 'acme/widgets',
    usage: {
      window: { spent: 0.42, resetsAt: NOW + 3 * 60 * MINUTE + 30 * MINUTE },
      weekly: { spent: 0.18, resetsAt: NOW + 4 * 24 * 60 * MINUTE },
      tokensPerHour: [0, 0, 1_200, 8_400, 22_000, 31_000, 12_000, 0, 4_100, 18_000, 41_000, 36_000],
    },
  };
}

// What each run has said so far, served to the TUI as it opens or follows it.
export const CONVERSATIONS: Record<string, ConversationEvent[]> = {
  R1: [
    { type: 'message', id: 'E1', from: 'operator', text: 'Grill me about retrying failed webhook deliveries.' },
    { type: 'toolUse', id: 'E2', tool: 'Read', summary: 'src/webhooks/deliver.ts' },
    { type: 'toolUse', id: 'E3', tool: 'Grep', summary: 'retry' },
    { type: 'message', id: 'E4', from: 'agent', text: 'Deliveries fail today with no retry. Which failures should be retried: 5xx and timeouts only, or 4xx too?' },
  ],
  R2: [
    { type: 'toolUse', id: 'E1', tool: 'Read', summary: 'src/status/command.ts' },
    { type: 'message', id: 'E2', from: 'agent', text: 'The status table needs a JSON twin: one formatter, two outputs.' },
    { type: 'toolUse', id: 'E3', tool: 'Edit', summary: 'src/status/json.ts' },
    { type: 'toolUse', id: 'E4', tool: 'Bash', summary: 'npm test -- status' },
    { type: 'message', id: 'E5', from: 'agent', text: 'Tests pass. Writing the JSON formatter for nested rows next.' },
  ],
};

// The demo's connection: a FakeConnection that knows the widgets clone and
// serves each run's conversation as the TUI opens or follows it.
export class DemoConnection extends FakeConnection {
  private readonly said: Record<string, ConversationEvent[]>;

  constructor(state: FactoryState = demoState(), said: Record<string, ConversationEvent[]> = CONVERSATIONS) {
    super();
    this.said = said;
    this.replyTo('inspectClone', { ok: true, value: { repo: 'acme/widgets', path: DEMO_CWD } });
    // A launch gets the next task id; nothing launches it.
    this.replyTo('launchTask', { ok: true, value: { taskId: 'T10' } });
    this.serveSnapshot(state);
  }

  override converse(runId: string, listener: ConversationListener): () => void {
    const leave = super.converse(runId, listener);
    this.replay(runId, listener);
    return leave;
  }

  override follow(runId: string, listener: ConversationListener): () => void {
    const unfollow = super.follow(runId, listener);
    this.replay(runId, listener);
    return unfollow;
  }

  private replay(runId: string, listener: ConversationListener): void {
    const events = this.said[runId] ?? [];
    queueMicrotask(() => {
      for (const event of events) listener(event);
    });
  }
}
