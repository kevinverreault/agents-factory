// Seam 2: the TUI against an in-memory fake protocol client.
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryState, TaskView } from '../protocol/factory-state.ts';
import { FakeConnection } from '../testing/fake-connection.ts';
import { App } from './app.ts';

const apps: { unmount(): void }[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
});

// A pause for the TUI to take in a keystroke or a message from the daemon.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
// Ink throttles its frames and React runs effects on its own schedule, so no
// fixed pause is always long enough under load: what the TUI should come to
// show or send is retried until it holds.
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 2_000, interval: 10 });

function task(id: string, title: string, state: TaskView['state'], label: string, mode: TaskView['mode'] = 'AFK'): TaskView {
  return { id, title, repo: 'acme/widgets', mode, autonomy: mode === 'AFK' ? 'L1' : null, groups: [], state, label, liveRunId: null, branch: null, worktree: null, sessionId: null };
}

function factoryState(tasks: TaskView[], attentionQueue: FactoryState['attentionQueue'] = []): FactoryState {
  return {
    repositories: {},
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    runs: {},
    artifacts: {},
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

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('1 Tasks');
      expect(frame).toMatch(/T1\s+Settle the glossary\s+Ready for you/);
      expect(frame).toMatch(/T2\s+Implement the store\s+Running/);
    });
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
    await eventually(() => expect(app.lastFrame()).toContain('2 Needs you (2)'));

    app.stdin.write('2');
    await settle();

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/T2\s+Implement the store\s+failure: The agent hit max turns\./);
      expect(frame).toMatch(/T1\s+Settle the glossary\s+Ready for you/);
      expect(frame).not.toContain('Write the spec');
    });

    app.stdin.write('1');
    await settle();
    await eventually(() => expect(app.lastFrame()).toContain('Write the spec'));
  });

  test('a patch from the daemon shows up live', async () => {
    const { app, connection } = await started(factoryState([task('T1', 'Implement the store', 'running', 'Running')]));

    connection.servePatch([
      { op: 'set', path: ['tasks', 'T1'], value: task('T1', 'Implement the store', 'in-review', 'In review') },
      { op: 'set', path: ['attentionQueue'], value: [{ kind: 'review', taskId: 'T1' }] },
    ]);
    await settle();

    await eventually(() => expect(app.lastFrame()).toMatch(/T1\s+Implement the store\s+In review/));
    await eventually(() => expect(app.lastFrame()).toContain('2 Needs you (1)'));
  });

  test('an empty factory says so, and a lost daemon connection is shown', async () => {
    const { app, connection } = await started(factoryState([]));
    await eventually(() => expect(app.lastFrame()).toContain('No tasks yet.'));

    connection.drop();
    await settle();

    await eventually(() => expect(app.lastFrame()).toContain('The daemon connection closed.'));
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
    await eventually(() => expect(connection.sent).toEqual([{ type: 'inspectClone', path: '/clones/widgets/src' }]));
    await eventually(() => expect(app.lastFrame()).toContain('acme/widgets is not registered. r Register this repo'));

    app.stdin.write('r');
    await settle();
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'registerRepo', path: widgets.path }));

    connection.servePatch([{ op: 'set', path: ['repositories', 'acme/widgets'], value: widgets }]);
    await settle();
    await eventually(() => expect(app.lastFrame()).not.toContain('Register this repo'));
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

    await eventually(() => expect(app.lastFrame()).toContain('The clone at /clones/widgets has no GitHub origin.'));
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

    await eventually(() => expect(app.lastFrame()).toMatch(/acme\/widgets\s+repo-missing: The clone of acme\/widgets is no longer at/));
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
    sessionId: '5f0c2a8e-3b1d-4c6e-9a7f-2d8b4e1c0a93',
  };
  const run = {
    id: 'R1',
    taskId: 'T1',
    mode: 'HITL' as const,
    autonomy: null,
    status: 'active' as const,
    outcome: null,
    turn: 'agent' as const,
    queued: [] as string[],
    question: null,
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
    await eventually(() => expect(app.lastFrame()).toMatch(/Launch a task[\s\S]*Repository\s+acme\/widgets/));
    await type(app, 'Grill me about the login flow.');
    app.stdin.write('\r');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' }));
    connection.servePatch([
      { op: 'set', path: ['tasks', 'T1'], value: conversing },
      { op: 'set', path: ['runs', 'R1'], value: run },
    ]);
    await settle();
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    await eventually(() => expect(app.lastFrame()).toMatch(/T1\s+Grill me about the login flow\.[\s\S]*factory\/T1-grill-me-about-the-login-flow[\s\S]*claude-sonnet-5-5/));
  });

  test('on the launch card, tab picks another repository, a refusal shows its reason, and esc backs out', async () => {
    const connection = new FakeConnection();
    connection.replyTo('launchTask', { ok: false, reason: "Couldn't fetch main from the origin of acme/gadgets: fatal: no network" });
    const { app } = await started({ ...factoryState([]), repositories }, { connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/Repository\s+acme\/gadgets/));
    app.stdin.write('\t');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/Repository\s+acme\/widgets/));
    app.stdin.write('\t');
    await type(app, 'Spike the cache');
    app.stdin.write('\r');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/gadgets', prompt: 'Spike the cache' }));
    await eventually(() => expect(app.lastFrame()).toContain("Couldn't fetch main from the origin of acme/gadgets: fatal: no network"));
    await eventually(() => expect(app.lastFrame()).toContain('Spike the cache'));

    app.stdin.write('\x1b');
    await settle();
    await eventually(() => expect(app.lastFrame()).not.toContain('Launch a task'));
    await eventually(() => expect(app.lastFrame()).toContain('No tasks yet.'));
  });

  test('the conversation view renders streamed text and tool use, and enter sends the operator’s message', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } }, { connection });
    app.stdin.write('\r');
    await settle();
    await eventually(() => expect(connection.conversed).toEqual(['R1']));

    connection.serveConversation(
      'R1',
      { type: 'message', id: 'E1', from: 'operator', text: 'Grill me about the login flow.' },
      { type: 'toolUse', id: 'E2', tool: 'Read', summary: 'src/auth/sso.ts' },
      { type: 'message', id: 'E3', from: 'agent', text: 'Which identity provider times out?' },
    );
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/you\s+Grill me about the login flow\.[^\n]*\n[\s\S]*Read\s+src\/auth\/sso\.ts[^\n]*\n[\s\S]*agent\s+Which identity provider times out\?/));

    await type(app, 'Okta, only on Safarii');
    app.stdin.write('\x7f');
    app.stdin.write('.');
    await settle();
    await eventually(() => expect(app.lastFrame()).toContain('› Okta, only on Safari.'));
    app.stdin.write('\r');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'sendMessage', taskId: 'T1', text: 'Okta, only on Safari.' }));
    await eventually(() => expect(app.lastFrame()).not.toContain('› Okta'));
  });

  test('mid-turn the view shows queued messages and esc interrupts; on the operator’s turn it says it is waiting on you', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } }, { connection });
    app.stdin.write('\r');
    await settle();
    expect(app.lastFrame()).not.toContain('waiting on you');

    connection.servePatch([{ op: 'set', path: ['runs', 'R1'], value: { ...run, queued: ['Also check Safari.'] } }]);
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/queued\s+Also check Safari\./));
    app.stdin.write('\x1b');
    await settle();
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'interrupt', taskId: 'T1' }));

    connection.servePatch([{ op: 'set', path: ['runs', 'R1'], value: { ...run, turn: 'operator' } }]);
    await settle();
    await eventually(() => expect(app.lastFrame()).toContain('waiting on you'));
    await eventually(() => expect(app.lastFrame()).not.toContain('queued'));
    app.stdin.write('\x1b');
    await settle();
    expect(connection.sent.filter((command) => command.type === 'interrupt')).toHaveLength(1);
  });

  const idp = {
    question: 'Which identity provider times out?',
    header: 'IdP',
    options: [
      { label: 'Okta', description: 'The workforce SSO' },
      { label: 'Auth0', description: 'The customer login' },
    ],
    multiSelect: false,
  };
  const browsers = {
    question: 'Which browsers fail?',
    header: 'Browsers',
    options: [
      { label: 'Safari', description: 'Desktop and iOS' },
      { label: 'Firefox', description: 'With strict tracking protection' },
      { label: 'Chrome', description: 'Incognito only' },
    ],
    multiSelect: true,
  };

  test('a question card shows each question with numbered options; digits answer it, and enter confirms a multi-select', async () => {
    const connection = new FakeConnection();
    const asking = { ...run, question: { id: 'toolu_01', questions: [idp, browsers] } };
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: asking } }, { connection });
    app.stdin.write('\r');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/IdP[\s\S]*Which identity provider times out\?[\s\S]*1\s+Okta\s+The workforce SSO[\s\S]*2\s+Auth0\s+The customer login/));

    app.stdin.write('1');
    await settle();
    await eventually(() => expect(app.lastFrame()).toContain('Which browsers fail?'));
    app.stdin.write('1');
    app.stdin.write('3');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/1\s+\[x\] Safari[\s\S]*2\s+\[ \] Firefox[\s\S]*3\s+\[x\] Chrome/));
    expect(connection.sent).toEqual([]);
    app.stdin.write('\r');
    await settle();

    await eventually(() =>
      expect(connection.sent).toEqual([
        {
          type: 'answerQuestion',
          taskId: 'T1',
          questionId: 'toolu_01',
          answers: { 'Which identity provider times out?': 'Okta', 'Which browsers fail?': 'Safari, Chrome' },
        },
      ]),
    );
    await eventually(() => expect(app.lastFrame()).not.toContain('Which browsers fail?'));
  });

  test('typing on a question card answers it in the operator’s own words', async () => {
    const connection = new FakeConnection();
    const asking = { ...run, question: { id: 'toolu_01', questions: [idp] } };
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: asking } }, { connection });
    app.stdin.write('\r');
    await settle();

    await type(app, 'Neither, a SAML IdP on 2 tenants');
    app.stdin.write('\r');
    await settle();

    await eventually(() =>
      expect(connection.sent).toEqual([
        { type: 'answerQuestion', taskId: 'T1', questionId: 'toolu_01', answers: { 'Which identity provider times out?': 'Neither, a SAML IdP on 2 tenants' } },
      ]),
    );
  });

  test('a refused answer keeps the card up with the reason', async () => {
    const connection = new FakeConnection();
    connection.replyTo('answerQuestion', { ok: false, reason: 'That question is no longer open.' });
    const asking = { ...run, question: { id: 'toolu_01', questions: [idp] } };
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: asking } }, { connection });
    app.stdin.write('\r');
    await settle();

    app.stdin.write('2');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toMatchObject({ type: 'answerQuestion', answers: { 'Which identity provider times out?': 'Auth0' } }));
    await eventually(() => expect(app.lastFrame()).toContain('That question is no longer open.'));
    await eventually(() => expect(app.lastFrame()).toMatch(/1\s+Okta\s+The workforce SSO/));
  });

  test('the conversation view shows the session id, to resume in the operator’s own terminal', async () => {
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } });
    app.stdin.write('\r');
    await settle();

    await eventually(() => expect(app.lastFrame()).toContain('claude --resume 5f0c2a8e-3b1d-4c6e-9a7f-2d8b4e1c0a93'));
  });

  const failing = task('T2', 'Implement the store', 'waiting', 'Needs you');
  const failure = {
    kind: 'attention' as const,
    taskId: 'T2',
    repo: 'acme/widgets',
    requestId: 'A1',
    attention: 'failure' as const,
    holdsRun: false,
    reason: 'The agent hit max turns.',
  };

  test('ctrl+b returns to the screen, pane and cursor the operator left, the cursor following the task it was on', async () => {
    const connection = new FakeConnection();
    const ready = { kind: 'ready' as const, taskId: 'T1' };
    const readyForYou = { ...conversing, label: 'Ready for you' };
    const { app } = await started({ ...factoryState([readyForYou, failing], [failure, ready]), runs: { R1: run } }, { connection });

    app.stdin.write('2');
    await settle();
    app.stdin.write('\x1b[B');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+T1\s+Grill me about the login flow\./));
    app.stdin.write('\r');
    await settle();
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    // In the conversation, T1 no longer waits on the operator.
    connection.servePatch([
      { op: 'set', path: ['tasks', 'T1'], value: conversing },
      { op: 'set', path: ['attentionQueue'], value: [failure] },
    ]);
    await settle();

    app.stdin.write('\x02');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+T2\s+Implement the store\s+failure/));
    connection.servePatch([
      { op: 'set', path: ['tasks', 'T1'], value: readyForYou },
      { op: 'set', path: ['attentionQueue'], value: [ready, failure] },
    ]);
    await settle();

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('2 Needs you (2)');
      expect(frame).toMatch(/›\s+T1\s+Grill me about the login flow\.\s+Ready for you/);
      expect(frame).toMatch(/ \s+T2\s+Implement the store\s+failure/);
    });
  });

  test('enter opens a conversation from Needs you only for a task Ready for you in a live one', async () => {
    const connection = new FakeConnection();
    const queued = task('T3', 'Settle the glossary', 'queued', 'Ready for you', 'HITL');
    const { app } = await started(factoryState([failing, queued], [failure, { kind: 'ready', taskId: 'T3' }]), { connection });

    app.stdin.write('2');
    await settle();
    app.stdin.write('\r');
    await settle();
    app.stdin.write('\x1b[B');
    app.stdin.write('\x1b[B');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+T3\s+Settle the glossary/));
    app.stdin.write('\r');
    await settle();

    expect(connection.conversed).toEqual([]);
    await eventually(() => expect(app.lastFrame()).toContain('2 Needs you (2)'));
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
    await eventually(() => expect(connection.left).toEqual(['R1']));
    await eventually(() => expect(app.lastFrame()).toMatch(/T1\s+Grill me about the login flow\.\s+In conversation/));
    await eventually(() => expect(app.lastFrame()).not.toContain('Which identity provider'));

    app.stdin.write('\r');
    await settle();
    await eventually(() => expect(connection.conversed).toEqual(['R1', 'R1']));
    expect(app.lastFrame()).not.toContain('Which identity provider');
  });

  test('the conversation’s artifact rail lists the task’s files and issues, and updates live', async () => {
    const connection = new FakeConnection();
    const artifacts: FactoryState['artifacts'] = {
      X1: { id: 'X1', taskId: 'T1', runId: 'R1', kind: 'file', path: 'GLOSSARY.md', committed: false },
      X2: { id: 'X2', taskId: 'T2', runId: 'R2', kind: 'file', path: 'docs/adr/0009-elsewhere.md', committed: false },
    };
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run }, artifacts }, { connection });
    app.stdin.write('\r');
    await eventually(() => {
      expect(app.lastFrame()).toContain('Artifacts');
      expect(app.lastFrame()).toMatch(/uncommitted\s+GLOSSARY\.md/);
    });
    expect(app.lastFrame()).not.toContain('0009-elsewhere');

    connection.servePatch([
      { op: 'set', path: ['artifacts', 'X1'], value: { ...artifacts.X1, committed: true } },
      { op: 'set', path: ['artifacts', 'X3'], value: { id: 'X3', taskId: 'T1', runId: 'R1', kind: 'file', path: 'docs/adr/0001-sso-cookies.md', committed: false } },
      { op: 'set', path: ['artifacts', 'X4'], value: { id: 'X4', taskId: 'T1', runId: 'R1', kind: 'issue', url: 'https://github.com/acme/widgets/issues/41' } },
    ]);

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/committed\s+GLOSSARY\.md/);
      expect(frame).not.toMatch(/uncommitted\s+GLOSSARY\.md/);
      expect(frame).toMatch(/uncommitted\s+docs\/adr\/0001-sso-cookies\.md/);
      expect(frame).toMatch(/issue\s+acme\/widgets#41/);
    });
  });
});
