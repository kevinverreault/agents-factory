// Seam 2: the TUI against an in-memory fake protocol client.
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryState, TaskView } from '../protocol/factory-state.ts';
import { FakeConnection } from '../testing/fake-connection.ts';
import { App } from './app.ts';

const apps: { unmount(): void }[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function task(id: string, title: string, state: TaskView['state'], label: string, mode: TaskView['mode'] = 'AFK'): TaskView {
  return { id, title, repo: 'acme/widgets', mode, autonomy: mode === 'AFK' ? 'L1' : null, groups: [], state, label, liveRunId: null, branch: null, worktree: null };
}

function factoryState(tasks: TaskView[], attentionQueue: FactoryState['attentionQueue'] = []): FactoryState {
  return {
    repositories: {},
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    runs: {},
    attentionQueue,
    slots: { active: 0, cap: 2 },
  };
}

async function started(state?: FactoryState, { cwd, connection = new FakeConnection() }: { cwd?: string; connection?: FakeConnection } = {}) {
  if (state) connection.serveSnapshot(state);
  const app = render(<App connection={connection} cwd={cwd} />);
  apps.push(app);
  await settle();
  return { connection, app };
}

describe('the bare TUI', () => {
  test('the Tasks tab lists every task with its label', async () => {
    const { app } = await started(
      factoryState([
        task('T1', 'Settle the glossary', 'queued', 'Ready for you', 'HITL'),
        task('T2', 'Implement the store', 'running', 'Running'),
      ]),
    );

    const frame = app.lastFrame()!;
    expect(frame).toContain('1 Tasks');
    expect(frame).toMatch(/T1\s+Settle the glossary\s+Ready for you/);
    expect(frame).toMatch(/T2\s+Implement the store\s+Running/);
  });

  test('the Needs you tab shows its count, and 2 switches to it', async () => {
    const { app } = await started(
      factoryState(
        [
          task('T1', 'Settle the glossary', 'queued', 'Ready for you', 'HITL'),
          task('T2', 'Implement the store', 'waiting', 'Needs you'),
          task('T3', 'Write the spec', 'running', 'Running'),
        ],
        [
          {
            kind: 'attention',
            taskId: 'T2',
            repo: 'acme/widgets',
            requestId: 'A1',
            attention: 'failure',
            holdsRun: false,
            reason: 'The agent hit max turns.',
          },
          { kind: 'ready', taskId: 'T1' },
        ],
      ),
    );
    expect(app.lastFrame()).toContain('2 Needs you (2)');

    app.stdin.write('2');
    await settle();

    const frame = app.lastFrame()!;
    expect(frame).toMatch(/T2\s+Implement the store\s+failure: The agent hit max turns\./);
    expect(frame).toMatch(/T1\s+Settle the glossary\s+Ready for you/);
    expect(frame).not.toContain('Write the spec');

    app.stdin.write('1');
    await settle();
    expect(app.lastFrame()).toContain('Write the spec');
  });

  test('a patch from the daemon shows up live', async () => {
    const { app, connection } = await started(factoryState([task('T1', 'Implement the store', 'running', 'Running')]));

    connection.servePatch([
      { op: 'set', path: ['tasks', 'T1'], value: task('T1', 'Implement the store', 'in-review', 'In review') },
      { op: 'set', path: ['attentionQueue'], value: [{ kind: 'review', taskId: 'T1' }] },
    ]);
    await settle();

    expect(app.lastFrame()).toMatch(/T1\s+Implement the store\s+In review/);
    expect(app.lastFrame()).toContain('2 Needs you (1)');
  });

  test('an empty factory says so, and a lost daemon connection is shown', async () => {
    const { app, connection } = await started(factoryState([]));
    expect(app.lastFrame()).toContain('No tasks yet.');

    connection.drop();
    await settle();

    expect(app.lastFrame()).toContain('The daemon connection closed.');
  });
});

describe('repositories', () => {
  const widgets = { id: 'acme/widgets', path: '/clones/widgets', baseBranch: 'main', defaultPreset: 'main-flow', missing: false };

  function inClone() {
    const connection = new FakeConnection();
    connection.replyTo('inspectClone', { ok: true, value: { repo: 'acme/widgets', path: widgets.path } });
    return connection;
  }

  test('started in an unregistered clone, the TUI offers Register this repo, and r registers it in one keystroke', async () => {
    const { app, connection } = await started(factoryState([]), { cwd: '/clones/widgets/src', connection: inClone() });
    expect(connection.sent).toEqual([{ type: 'inspectClone', path: '/clones/widgets/src' }]);
    expect(app.lastFrame()).toContain('acme/widgets is not registered. r Register this repo');

    app.stdin.write('r');
    await settle();
    expect(connection.sent.at(-1)).toEqual({ type: 'registerRepo', path: widgets.path });

    connection.servePatch([{ op: 'set', path: ['repositories', 'acme/widgets'], value: widgets }]);
    await settle();
    expect(app.lastFrame()).not.toContain('Register this repo');
  });

  test('started in a registered clone, or outside any clone, the TUI offers nothing and r does nothing', async () => {
    const registered = await started({ ...factoryState([]), repositories: { 'acme/widgets': widgets } }, { cwd: widgets.path, connection: inClone() });
    const outside = new FakeConnection();
    outside.replyTo('inspectClone', { ok: false, reason: '/notes is not inside a git clone.' });
    const elsewhere = await started(factoryState([]), { cwd: '/notes', connection: outside });

    for (const { app, connection } of [registered, elsewhere]) {
      app.stdin.write('r');
      await settle();
      expect(app.lastFrame()).not.toContain('Register this repo');
      expect(connection.sent.map((command) => command.type)).toEqual(['inspectClone']);
    }
  });

  test('a refused registration shows its reason', async () => {
    const connection = inClone();
    connection.replyTo('registerRepo', { ok: false, reason: 'The clone at /clones/widgets has no GitHub origin.' });
    const { app } = await started(factoryState([]), { cwd: widgets.path, connection });

    app.stdin.write('r');
    await settle();

    expect(app.lastFrame()).toContain('The clone at /clones/widgets has no GitHub origin.');
  });

  test('a missing repository shows in Needs you under its name', async () => {
    const { app } = await started(
      factoryState(
        [],
        [
          {
            kind: 'attention',
            taskId: null,
            repo: 'acme/widgets',
            requestId: 'A1',
            attention: 'repo-missing',
            holdsRun: false,
            reason: 'The clone of acme/widgets is no longer at /clones/widgets.',
          },
        ],
      ),
    );

    app.stdin.write('2');
    await settle();

    expect(app.lastFrame()).toMatch(/acme\/widgets\s+repo-missing: The clone of acme\/widgets is no longer at/);
  });
});

describe('launching and conversing', () => {
  const widgets = { id: 'acme/widgets', path: '/clones/widgets', baseBranch: 'main', defaultPreset: 'main-flow', missing: false };
  const gadgets = { ...widgets, id: 'acme/gadgets', path: '/clones/gadgets' };
  const conversing: TaskView = {
    ...task('T1', 'Grill me about the login flow.', 'running', 'In conversation', 'HITL'),
    liveRunId: 'R1',
    branch: 'factory/T1-grill-me-about-the-login-flow',
    worktree: '/worktrees/acme-widgets/T1',
  };
  const run = {
    id: 'R1',
    taskId: 'T1',
    mode: 'HITL' as const,
    autonomy: null,
    status: 'active' as const,
    outcome: null,
    model: 'claude-sonnet-5-5',
    cli: { pid: 4242, createdAt: 1 },
    startedAt: 1,
    endedAt: null,
  };
  const repositories = { 'acme/gadgets': gadgets, 'acme/widgets': widgets };

  function inWidgets() {
    const connection = new FakeConnection();
    connection.replyTo('inspectClone', { ok: true, value: { repo: 'acme/widgets', path: widgets.path } });
    return connection;
  }

  async function type(app: { stdin: { write(data: string): void } }, text: string) {
    for (const char of text) app.stdin.write(char);
    await settle();
  }

  test('N opens the launch card on the repository holding the working directory, and enter launches the prompt into its conversation', async () => {
    const connection = inWidgets();
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    expect(app.lastFrame()).toMatch(/Launch a task[\s\S]*Repository\s+acme\/widgets/);
    await type(app, 'Grill me about the login flow.');
    app.stdin.write('\r');
    await settle();

    expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });
    connection.servePatch([
      { op: 'set', path: ['tasks', 'T1'], value: conversing },
      { op: 'set', path: ['runs', 'R1'], value: run },
    ]);
    await settle();
    expect(connection.conversed).toEqual(['R1']);
    expect(app.lastFrame()).toMatch(/T1\s+Grill me about the login flow\.[\s\S]*factory\/T1-grill-me-about-the-login-flow[\s\S]*claude-sonnet-5-5/);
  });

  test('on the launch card, tab picks another repository, a refusal shows its reason, and esc backs out', async () => {
    const connection = new FakeConnection();
    connection.replyTo('launchTask', { ok: false, reason: "Couldn't fetch main from the origin of acme/gadgets: fatal: no network" });
    const { app } = await started({ ...factoryState([]), repositories }, { connection });

    app.stdin.write('N');
    await settle();
    expect(app.lastFrame()).toMatch(/Repository\s+acme\/gadgets/);
    app.stdin.write('\t');
    await settle();
    expect(app.lastFrame()).toMatch(/Repository\s+acme\/widgets/);
    app.stdin.write('\t');
    await type(app, 'Spike the cache');
    app.stdin.write('\r');
    await settle();

    expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/gadgets', prompt: 'Spike the cache' });
    expect(app.lastFrame()).toContain("Couldn't fetch main from the origin of acme/gadgets: fatal: no network");
    expect(app.lastFrame()).toContain('Spike the cache');

    app.stdin.write('\x1b');
    await settle();
    expect(app.lastFrame()).not.toContain('Launch a task');
    expect(app.lastFrame()).toContain('No tasks yet.');
  });

  test('the conversation view renders streamed text and tool use, and enter sends the operator’s message', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } }, { connection });
    app.stdin.write('\r');
    await settle();
    expect(connection.conversed).toEqual(['R1']);

    connection.serveConversation(
      'R1',
      { type: 'message', id: 'E1', from: 'operator', text: 'Grill me about the login flow.' },
      { type: 'toolUse', id: 'E2', tool: 'Read', summary: 'src/auth/sso.ts' },
      { type: 'message', id: 'E3', from: 'agent', text: 'Which identity provider times out?' },
    );
    await settle();
    expect(app.lastFrame()).toMatch(/you\s+Grill me about the login flow\.\n[\s\S]*Read\s+src\/auth\/sso\.ts\n[\s\S]*agent\s+Which identity provider times out\?/);

    await type(app, 'Okta, only on Safarii');
    app.stdin.write('\x7f');
    app.stdin.write('.');
    await settle();
    expect(app.lastFrame()).toContain('› Okta, only on Safari.');
    app.stdin.write('\r');
    await settle();

    expect(connection.sent.at(-1)).toEqual({ type: 'sendMessage', taskId: 'T1', text: 'Okta, only on Safari.' });
    expect(app.lastFrame()).not.toContain('› Okta');
  });

  test('ctrl+b leaves the conversation for the task list, and reopening it replays the conversation afresh', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } }, { connection });
    app.stdin.write('\r');
    await settle();
    connection.serveConversation('R1', { type: 'message', id: 'E1', from: 'agent', text: 'Which identity provider times out?' });
    await settle();

    app.stdin.write('\x02');
    await settle();
    expect(connection.left).toEqual(['R1']);
    expect(app.lastFrame()).toMatch(/T1\s+Grill me about the login flow\.\s+In conversation/);
    expect(app.lastFrame()).not.toContain('Which identity provider');

    app.stdin.write('\r');
    await settle();
    expect(connection.conversed).toEqual(['R1', 'R1']);
    expect(app.lastFrame()).not.toContain('Which identity provider');
  });
});
