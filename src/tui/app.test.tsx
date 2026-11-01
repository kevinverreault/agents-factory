// Seam 2: the TUI against an in-memory fake protocol client.
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryState, RunView, TaskView } from '../protocol/factory-state.ts';
import type { PresetsView } from '../protocol/protocol.ts';
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
  return { id, title, repo: 'acme/widgets', parent: null, depth: 0, child: null, status: null, rollup: null, mode, autonomy: mode === 'AFK' ? 'L1' : null, priority: 'normal', groups: [], state, label, liveRunId: null, branch: null, worktree: null, sessionId: null, skillSet: null, preset: null, stage: null, tier: 'sonnet', allowRules: [], goal: null, handoff: null, closedTickets: [], skippedTickets: [], loop: null, reopening: null, prBody: null, cleanup: null, transcripts: null };
}

function factoryState(tasks: TaskView[], attentionQueue: FactoryState['attentionQueue'] = []): FactoryState {
  return {
    repositories: {},
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    runs: {},
    artifacts: {},
    attentionQueue,
    slots: { active: 0, cap: 2 },
    lastUsedRepo: null,
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
            question: null,
            permission: null,
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

describe('re-tiering', () => {
  test('each task shows the tier its next run starts at, and t moves the selected task to the next tier', async () => {
    const { app, connection } = await started(
      factoryState([task('T1', 'Settle the glossary', 'queued', 'Ready for you', 'HITL'), task('T2', 'Implement the store', 'running', 'Running')]),
    );
    await eventually(() => expect(app.lastFrame()).toMatch(/T2\s+Implement the store\s+Running · sonnet/));
    expect(app.lastFrame()).toContain('t re-tier');

    app.stdin.write('\x1b[B');
    await settle();
    // Typed in one burst: each press goes on from the last.
    app.stdin.write('t');
    app.stdin.write('t');
    await eventually(() =>
      expect(connection.sent).toEqual([
        { type: 'retier', taskId: 'T2', tier: 'haiku' },
        { type: 'retier', taskId: 'T2', tier: 'opus' },
      ]),
    );

    connection.servePatch([{ op: 'set', path: ['tasks', 'T2', 'tier'], value: 'opus' }]);
    await eventually(() => expect(app.lastFrame()).toMatch(/T2\s+Implement the store\s+Running · opus/));
    app.stdin.write('t');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'retier', taskId: 'T2', tier: 'sonnet' }));
  });

  test('a refused re-tier says why', async () => {
    const { app, connection } = await started(factoryState([task('T1', 'Implement the store', 'done', 'Done')]));
    connection.replyTo('retier', { ok: false, reason: 'T1 is already Done.' });

    app.stdin.write('t');

    await eventually(() => expect(app.lastFrame()).toContain('T1 is already Done.'));
  });
});

describe('cancelling', () => {
  const [ESC, ENTER] = ['\x1b', '\r'];
  const keep = { type: 'cancel' as const, taskId: 'T2', branch: 'keep' as const };
  const discard = { type: 'cancel' as const, taskId: 'T2', branch: 'discard' as const };
  const choose = [
    { label: 'Keep branch', command: keep },
    { label: 'Discard work', command: discard },
  ];
  const tasks = () => factoryState([task('T1', 'Settle the glossary', 'queued', 'Ready for you', 'HITL'), task('T2', 'Implement the store', 'running', 'Running')]);

  test('x cancels the selected task, subtree and all', async () => {
    const { app, connection } = await started(tasks());
    await eventually(() => expect(app.lastFrame()).toContain('x cancel'));

    await press(app, '\x1b[B', 'x');

    await eventually(() => expect(connection.sent).toEqual([{ type: 'cancel', taskId: 'T2' }]));
  });

  test('when work would be lost, the cancel sheet asks once: enter keeps the branch, 2 discards the work, esc backs out', async () => {
    const { app, connection } = await started(tasks());
    connection.replyTo('cancel', { ok: false, reason: 'factory/T2-implement-the-store has 1 commit that exists nowhere else.', choose });
    await press(app, '\x1b[B', 'x');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain(
        'Cancel T2: factory/T2-implement-the-store has 1 commit that exists nowhere else. 1 Keep branch 2 Discard work enter Keep branch · esc back',
      ),
    );

    await press(app, ESC);
    await eventually(() => expect(app.lastFrame()).not.toContain('Keep branch'));
    expect(connection.sent).toHaveLength(1);

    await press(app, 'x');
    await eventually(() => expect(app.lastFrame()).toContain('Keep branch'));
    connection.replyTo('cancel', { ok: true });
    await press(app, ENTER);
    await eventually(() => expect(connection.sent.at(-1)).toEqual(keep));
    await eventually(() => expect(app.lastFrame()).not.toContain('Keep branch'));

    connection.replyTo('cancel', { ok: false, reason: 'factory/T2-implement-the-store has 1 commit that exists nowhere else.', choose });
    await press(app, 'x');
    await eventually(() => expect(app.lastFrame()).toContain('Keep branch'));
    connection.replyTo('cancel', { ok: true });
    await press(app, '2');
    await eventually(() => expect(connection.sent.at(-1)).toEqual(discard));
  });

  test('a refused cancel says why', async () => {
    const { app, connection } = await started(factoryState([task('T1', 'Implement the store', 'done', 'Done')]));
    connection.replyTo('cancel', { ok: false, reason: 'T1 is already Done.' });

    await press(app, 'x');

    await eventually(() => expect(app.lastFrame()).toContain('T1 is already Done.'));
  });
});

describe('finishing a loop', () => {
  test('f finishes the selected loop after its ticket, and its row says so', async () => {
    const looping = { ...task('T1', 'Implement the spec', 'running', 'Running'), loop: { ticket: 'acme/widgets#11', finishing: false } };
    const { app, connection } = await started(factoryState([looping]));
    await eventually(() => expect(app.lastFrame()).toMatch(/T1\s+Implement the spec\s+Running · sonnet · on acme\/widgets#11/));
    expect(app.lastFrame()).toContain('f finish after this ticket');

    await press(app, 'f');

    await eventually(() => expect(connection.sent).toEqual([{ type: 'finishLoop', taskId: 'T1' }]));
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1', 'loop'], value: { ticket: 'acme/widgets#11', finishing: true } }]);
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/Running · sonnet · on acme\/widgets#11, finishing after it/));
  });
});

describe('the task tree', () => {
  const failure = (taskId: string): FactoryState['attentionQueue'][number] => ({
    kind: 'attention',
    taskId,
    repo: 'acme/widgets',
    requestId: 'A1',
    attention: 'failure',
    holdsRun: false,
    reason: 'Boom.',
    question: null,
    permission: null,
  });
  // T1, a root with children T2 (failed), T3 (running) and grandchild T4, and T5, another root launched after.
  const tree = () =>
    factoryState(
      [
        {
          ...task('T1', 'Add a logout button', 'running', 'Running'),
          status: 'Wiring the header.',
          rollup: { done: 0, running: 2, needsYou: 1, cancelled: 0, failed: [{ taskId: 'T2', reason: 'Boom.' }] },
        },
        task('T5', 'Another root', 'queued', 'Queued'),
        { ...task('T2', 'Survey sign-out', 'waiting', 'Needs you'), parent: 'T1', depth: 1 },
        { ...task('T3', 'Write the docs', 'running', 'Running'), parent: 'T1', depth: 1, rollup: { done: 1, running: 0, needsYou: 0, cancelled: 0, failed: [] } },
        { ...task('T4', 'Check the links', 'done', 'Done'), parent: 'T3', depth: 2 },
      ],
      [failure('T2')],
    );

  test('children show under their parent, rows roll up their descendants, the root shows a failed child, and a status shows on its row', async () => {
    const { app } = await started(tree());

    await eventually(() => {
      const rows = app.lastFrame()!.split('\n').filter((line) => /T\d/.test(line));
      expect(rows.map((row) => /T\d/.exec(row)![0])).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
      expect(unwrapped(app.lastFrame()!)).toMatch(/T1 +Add a logout button +Running · sonnet · \[2 running, 1 needs you\] · T2 failed · Wiring the header\./);
      expect(unwrapped(app.lastFrame()!)).toMatch(/T2 +└ Survey sign-out +Needs you/);
      expect(unwrapped(app.lastFrame()!)).toMatch(/T3 +└ Write the docs +Running · sonnet · \[1 done\]/);
      expect(unwrapped(app.lastFrame()!)).toMatch(/T4 +└ Check the links +Done/);
    });
  });

  test('a failed child is retried with y from the tree, re-tiered with t, taken over with c and cancelled with x', async () => {
    const { app, connection } = await started(tree());
    await press(app, '\x1b[B');
    await eventually(() => expect(app.lastFrame()).toContain('y retry'));

    await press(app, 'y', 't', 'x');
    await eventually(() =>
      expect(connection.sent).toEqual([
        { type: 'answer', taskId: 'T2' },
        { type: 'retier', taskId: 'T2', tier: 'haiku' },
        { type: 'cancel', taskId: 'T2' },
      ]),
    );
    await press(app, 'c');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'takeOver', taskId: 'T2' }));
  });

  test('y does nothing on a task that hasn’t failed', async () => {
    const { app, connection } = await started(tree());
    await eventually(() => expect(app.lastFrame()).toContain('T1'));
    expect(app.lastFrame()).not.toContain('y retry');

    await press(app, 'y');

    expect(connection.sent).toEqual([]);
  });
});

describe('repositories', () => {
  const widgets = { id: 'acme/widgets', path: '/clones/widgets', baseBranch: 'main', defaultPreset: 'main-flow', missing: false, app: null, skills: null };

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

  const unset = {
    ...widgets,
    skills: {
      present: false as const,
      checkedAt: 1,
      reason: 'acme/widgets has no setup for the skill set on main (missing docs/agents/issue-tracker.md): its skills won’t find the issue tracker and labels they expect.',
      failed: false,
    },
  };

  test('a repository without the skill set’s setup shows why, and s launches its HITL setup task into the conversation', async () => {
    const connection = inClone();
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories: { 'acme/widgets': unset } }, { cwd: widgets.path, connection });
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain(`${unset.skills.reason} s Set up now`));

    app.stdin.write('s');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', preset: 'setup' }));
    const setup = { ...task('T1', 'setup', 'running', 'In conversation', 'HITL'), preset: { name: 'setup' } as TaskView['preset'] };
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: setup }]);
    await eventually(() => expect(app.lastFrame()).not.toContain('1 Tasks'));
  });

  test('once set up, while a setup task is unfinished, or when the check failed, nothing is offered and s does nothing', async () => {
    const present = { ...widgets, skills: { present: true as const, checkedAt: 1 } };
    const setUp = await started({ ...factoryState([]), repositories: { 'acme/widgets': present } });
    const setup = { ...task('T1', 'setup', 'waiting', 'Ready for you', 'HITL'), preset: { name: 'setup' } as TaskView['preset'] };
    const settingUp = await started({ ...factoryState([setup]), repositories: { 'acme/widgets': unset } });
    const reason = 'The factory couldn’t check the skill set’s setup in acme/widgets: couldn’t fetch main from origin (fatal: no network).';
    const failed = { ...widgets, skills: { present: false as const, checkedAt: 1, reason, failed: true } };
    const unchecked = await started({ ...factoryState([]), repositories: { 'acme/widgets': failed } });

    for (const { app, connection } of [setUp, settingUp, unchecked]) {
      app.stdin.write('s');
      await settle();
      expect(app.lastFrame()).not.toContain('Set up now');
      expect(connection.sent).toEqual([]);
    }
    expect(settingUp.app.lastFrame()).toContain('acme/widgets is being set up for the skill set in T1.');
    expect(unwrapped(unchecked.app.lastFrame()!)).toContain(reason);
  });

  test('a refused setup launch shows its reason', async () => {
    const connection = new FakeConnection();
    connection.replyTo('launchTask', { ok: false, reason: 'The daemon is stopping.' });
    const { app } = await started({ ...factoryState([]), repositories: { 'acme/widgets': unset } }, { connection });

    app.stdin.write('s');
    await settle();

    await eventually(() => expect(app.lastFrame()).toContain('The daemon is stopping.'));
  });

  test('R re-checks the repository’s setup, a failed check included, and the answer replaces the line', async () => {
    const reason = 'The factory couldn’t check the skill set’s setup in acme/widgets: couldn’t fetch main from origin (fatal: no network).';
    const failed = { ...widgets, skills: { present: false as const, checkedAt: 1, reason, failed: true } };
    const connection = new FakeConnection();
    connection.replyTo('checkSkills', { ok: true, value: { present: true, checkedAt: 2 } });
    const { app } = await started({ ...factoryState([]), repositories: { 'acme/widgets': failed } }, { connection });
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain(`${reason} R re-check`));

    app.stdin.write('R');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'checkSkills', repo: 'acme/widgets' }));
    connection.servePatch([{ op: 'set', path: ['repositories', 'acme/widgets'], value: { ...widgets, skills: { present: true, checkedAt: 2 } } }]);
    await eventually(() => expect(app.lastFrame()).not.toContain('re-check'));
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
            question: null,
            permission: null,
          },
        ],
      ),
    );

    app.stdin.write('2');
    await settle();

    await eventually(() => expect(app.lastFrame()).toMatch(/acme\/widgets\s+repo-missing: The clone of acme\/widgets is no longer at/));
  });
});

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';

// A frame's text with the card's border and wrapping taken out.
const unwrapped = (frame: string) => frame.replace(/[│\s]+/g, ' ');

async function press(app: { stdin: { write(data: string): void } }, ...keys: string[]) {
  for (const key of keys) {
    app.stdin.write(key);
    await settle();
  }
}

describe('launching and conversing', () => {
  const widgets = { id: 'acme/widgets', path: '/clones/widgets', baseBranch: 'main', defaultPreset: 'main-flow', missing: false, app: null, skills: null };
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
    permission: null,
    stage: 'grill' as string | null,
    ticket: null,
    proposal: null as RunView['proposal'],
    tier: 'sonnet' as const,
    model: 'claude-sonnet-5-5',
    maxTurns: null,
    cli: { pid: 4242, createdAt: 1 },
    skillSet: null,
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

  test('on the launch card, ↑↓ move between fields, ←→ pick another repository, a refusal shows its reason, and esc backs out', async () => {
    const connection = new FakeConnection();
    connection.replyTo('launchTask', { ok: false, reason: "Couldn't fetch main from the origin of acme/gadgets: fatal: no network" });
    const { app } = await started({ ...factoryState([]), repositories }, { connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/Repository\s+acme\/gadgets/));
    await press(app, UP, UP, UP, UP, RIGHT);
    await eventually(() => expect(app.lastFrame()).toMatch(/Repository\s+‹ acme\/widgets ›/));
    await press(app, RIGHT, DOWN, DOWN, DOWN);
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

  const presetsView: PresetsView = {
    defaultPreset: 'main-flow',
    warning: null,
    presets: [
      {
        name: 'main-flow',
        source: 'built-in',
        description: 'Grill, spec and tickets with you, then implement, review and open a PR unattended.',
        startStages: [
          { id: 'grill', mode: 'HITL', model: 'opus', needs: ['prompt'] },
          { id: 'tickets', mode: 'HITL', model: 'opus', needs: ['issues'] },
          { id: 'implement', mode: 'AFK', model: 'sonnet', needs: ['issues'] },
        ],
        appStages: ['implement', 'review', 'pr-body', 'open-pr'],
      },
      { name: 'nightly', source: 'user', error: 'Preset nightly (user, nightly.preset.yaml): stage implement: exit all-green is not an exit condition.' },
      { name: 'quick', source: 'built-in', description: null, startStages: [{ id: 'grill', mode: 'HITL', model: 'opus', needs: ['prompt'] }], appStages: ['implement', 'review', 'pr-body', 'open-pr'] },
      { name: 'setup', source: 'built-in', description: null, startStages: [{ id: 'setup', mode: 'HITL', model: 'sonnet', needs: [] }], appStages: [] },
    ],
  };

  test('where the App isn’t installed, a preset with AFK stages shows why, and ctrl+o opens the installation settings', async () => {
    const connection = inWidgets();
    connection.replyTo('listPresets', { ok: true, value: presetsView });
    const fixUrl = 'https://github.com/apps/agents-factory-kevin/installations/new';
    const uninstalled = {
      ...widgets,
      app: { installed: false as const, checkedAt: 1, reason: 'The factory’s GitHub App, agents-factory-kevin, isn’t installed on acme/widgets.', fixUrl },
    };
    const opened: string[] = [];
    connection.serveSnapshot({ ...factoryState([]), repositories: { ...repositories, 'acme/widgets': uninstalled } });
    const app = render(<App connection={connection} cwd="/clones/widgets/src" openUrl={(url) => opened.push(url)} />);
    apps.push(app);
    await settle();

    app.stdin.write('N');
    await settle();
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('main-flow works unattended as the factory’s App (at implement, review, pr-body, open-pr).');
      expect(frame).toContain('isn’t installed on acme/widgets.');
      expect(frame).toContain('ctrl+o opens its installation settings');
    });
    // The cached check may be stale: the card asks for a fresh one.
    expect(connection.sent).toContainEqual({ type: 'checkApp', repo: 'acme/widgets' });
    app.stdin.write('\x0f');
    await eventually(() => expect(opened).toEqual([fixUrl]));
    expect(app.lastFrame()).toContain('Launch a task');
    // Once the operator has installed it, the fresh check lifts the block.
    connection.servePatch([{ op: 'set', path: ['repositories', 'acme/widgets'], value: { ...uninstalled, app: { installed: true, checkedAt: 2 } } }]);
    await eventually(() => expect(app.lastFrame()).not.toContain('works unattended'));
    connection.servePatch([{ op: 'set', path: ['repositories', 'acme/widgets'], value: uninstalled }]);

    // A preset with no AFK stage launches as usual.
    await press(app, UP, UP, LEFT);
    await eventually(() => expect(app.lastFrame()).toMatch(/Preset\s+‹ setup \(built-in\) ›/));
    expect(app.lastFrame()).not.toContain('works unattended');
  });

  test('a start stage that needs no launch input launches with an empty prompt', async () => {
    const connection = inWidgets();
    connection.replyTo('listPresets', { ok: true, value: presetsView });
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/Preset\s+main-flow/));
    app.stdin.write('\r');
    await settle();
    expect(connection.sent.filter((command) => command.type === 'launchTask')).toEqual([]);
    await press(app, UP, UP, LEFT);
    await eventually(() => expect(app.lastFrame()).toMatch(/Preset\s+‹ setup \(built-in\) ›/));
    app.stdin.write('\r');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', preset: 'setup', stage: 'setup', prompt: '' }));
  });

  test('the card starts on the repository’s default preset and offers only the stages it can start at; starting at implement asks for issue refs', async () => {
    const connection = inWidgets();
    connection.replyTo('listPresets', { ok: true, value: presetsView });
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/Preset\s+main-flow \(built-in\)/);
      expect(frame).toContain('Grill, spec and tickets with you');
      expect(frame).toMatch(/Start stage\s+grill · HITL · opus/);
      expect(frame).not.toContain('Issues');
    });
    expect(connection.sent).toContainEqual({ type: 'listPresets', repo: 'acme/widgets' });

    await press(app, UP, RIGHT, RIGHT);
    await eventually(() => expect(app.lastFrame()).toMatch(/Start stage\s+‹ implement · AFK · sonnet ›/));
    await press(app, RIGHT);
    await eventually(() => expect(app.lastFrame()).toMatch(/Start stage\s+‹ grill · HITL · opus ›/));
    await press(app, LEFT);
    await eventually(() => expect(app.lastFrame()).toMatch(/Issues/));
    await press(app, DOWN, DOWN);
    await type(app, '#12 #13');
    app.stdin.write('\r');
    await settle();

    await eventually(() =>
      expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', prompt: '', issues: ['#12', '#13'] }),
    );
  });

  test('an AFK start stage shows the handoff fields, and the card sends the max turns and priority the operator set', async () => {
    const connection = inWidgets();
    connection.replyTo('listPresets', { ok: true, value: presetsView });
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/Start stage\s+grill · HITL · opus/));
    expect(app.lastFrame()).not.toMatch(/Autonomy|Max turns|Priority/);
    await press(app, UP, RIGHT, RIGHT);
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/Autonomy\s+L1 \(L2 arrives with the sandbox\)/);
      expect(frame).toMatch(/Model tier\s+stage default \(sonnet\)/);
      expect(frame).toMatch(/Max turns\s+stage default \(300\)/);
      expect(frame).toMatch(/Priority\s+normal/);
    });
    await press(app, DOWN, DOWN);
    await type(app, '#12');
    await press(app, DOWN, DOWN, DOWN);
    await type(app, '4x0');
    await eventually(() => expect(app.lastFrame()).toMatch(/Max turns\s+40▏/));
    await press(app, DOWN, RIGHT);
    await eventually(() => expect(app.lastFrame()).toMatch(/Priority\s+‹ urgent ›/));
    app.stdin.write('\r');
    await settle();

    await eventually(() =>
      expect(connection.sent.at(-1)).toEqual({
        type: 'launchTask',
        repo: 'acme/widgets',
        preset: 'main-flow',
        stage: 'implement',
        prompt: '',
        issues: ['#12'],
        maxTurns: 40,
        priority: 'urgent',
      }),
    );
  });

  test('a preset that doesn’t resolve shows why, and a dangling default preset warns that main-flow is picked instead', async () => {
    const connection = inWidgets();
    const warning = 'The default preset of acme/widgets, nightly, no longer resolves (There is no preset nightly.), so main-flow is picked instead.';
    connection.replyTo('listPresets', { ok: true, value: { ...presetsView, warning } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain(warning));
    await press(app, UP, UP, RIGHT);

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/Preset\s+‹ nightly \(user\) ›/);
      expect(unwrapped(frame)).toContain('exit all-green is not an exit condition.');
      expect(frame).not.toMatch(/Start stage\s+grill/);
    });
  });

  test('a daemon that acks listPresets without a listing gets the card out of loading and still launches with the defaults', async () => {
    const connection = inWidgets();
    connection.replyTo('listPresets', { ok: true });
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).not.toContain('loading…');
      expect(frame).toContain('The daemon listed no presets: the launch takes the repository’s defaults.');
    });
    await type(app, 'Spike the cache');
    app.stdin.write('\r');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Spike the cache' }));
  });

  test('outside any registered clone the card starts on the last used repository, and it tags groups and picks a model tier', async () => {
    const connection = new FakeConnection();
    connection.replyTo('listPresets', { ok: true, value: presetsView });
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories, lastUsedRepo: 'acme/widgets' }, { connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/Repository\s+acme\/widgets/));
    await eventually(() => expect(app.lastFrame()).toMatch(/Model tier\s+stage default \(opus\)/));
    await type(app, 'Spike the cache');
    await press(app, DOWN);
    await type(app, 'billing, sso');
    await press(app, DOWN, RIGHT);
    await eventually(() => expect(app.lastFrame()).toMatch(/Model tier\s+‹ opus ›/));
    app.stdin.write('\r');
    await settle();

    await eventually(() =>
      expect(connection.sent.at(-1)).toEqual({
        type: 'launchTask',
        repo: 'acme/widgets',
        preset: 'main-flow',
        stage: 'grill',
        prompt: 'Spike the cache',
        groups: ['billing', 'sso'],
        tier: 'opus',
      }),
    );
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

  test('the conversation view of an AFK run follows it live but takes no chat: typing, enter and esc send nothing', async () => {
    const connection = new FakeConnection();
    const working: TaskView = { ...task('T1', 'Implement acme/widgets#12', 'running', 'Running'), liveRunId: 'R1' };
    const afkRun = { ...run, mode: 'AFK' as const, autonomy: 'L1' as const, maxTurns: 300 };
    const { app } = await started({ ...factoryState([working]), runs: { R1: afkRun } }, { connection });
    app.stdin.write('\r');
    await settle();
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    connection.serveConversation('R1', { type: 'message', id: 'E1', from: 'agent', text: 'Reading the ticket.' });
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/agent\s+Reading the ticket\./));

    await type(app, 'Use the new API');
    app.stdin.write('\r');
    app.stdin.write('\x1b');
    await settle();

    const frame = app.lastFrame()!;
    expect(frame).not.toContain('Use the new API');
    expect(frame).not.toContain('›');
    expect(frame).toContain('AFK runs take no chat: c takes it over to talk to it · ctrl+b back');
    expect(connection.sent.filter((command) => command.type === 'sendMessage' || command.type === 'interrupt')).toEqual([]);
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
    question: null,
    permission: null,
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

  // A frozen preset of HITL stages up to the handoff to implement.
  const hitlStage = (id: string, more: object = {}) => ({ id, kind: 'run' as const, skill: id, mode: 'HITL' as const, model: 'opus' as const, ...more });
  const lean = {
    name: 'lean',
    description: null,
    source: 'user' as const,
    path: 'lean.preset.yaml',
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
  const onLean = { ...conversing, preset: lean, stage: 'grill' };
  const CTRL_N = '\x0e';

  test('the agent’s proposal to advance shows as a banner with its reason, and ctrl+n opens the advance sheet on it', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([onLean]), runs: { R1: run } }, { connection });
    app.stdin.write('\r');
    await settle();
    await eventually(() => expect(app.lastFrame()).toContain('ctrl+n advance'));
    expect(app.lastFrame()).not.toContain('proposes');

    connection.servePatch([{ op: 'set', path: ['runs', 'R1'], value: { ...run, proposal: { kind: 'advance', reason: 'The login flow is settled.' } } }]);
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('The agent proposes advancing: The login flow is settled. ctrl+n review'));

    app.stdin.write(CTRL_N);
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('Advance T1 from grill');
      expect(frame).toMatch(/› glossary opus optional ← advances here spec opus optional tickets opus then implement \(AFK\): the handoff starts it/);
    });
  });

  test('enter on the advance sheet advances the task, and the conversation carries on with the next stage’s run', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([onLean]), runs: { R1: run } }, { connection });
    app.stdin.write('\r');
    await settle();
    app.stdin.write(CTRL_N);
    await eventually(() => expect(app.lastFrame()).toContain('Advance T1 from grill'));

    app.stdin.write('\r');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'advanceStage', taskId: 'T1' }));
    await eventually(() => expect(app.lastFrame()).not.toContain('Advance T1'));

    connection.servePatch([
      { op: 'set', path: ['runs', 'R1'], value: { ...run, status: 'ended', outcome: 'completed' } },
      { op: 'set', path: ['runs', 'R2'], value: { ...run, id: 'R2', stage: 'glossary' } },
      { op: 'set', path: ['tasks', 'T1'], value: { ...onLean, stage: 'glossary', liveRunId: 'R2' } },
    ]);
    await eventually(() => expect(connection.conversed).toEqual(['R1', 'R2']));
    await eventually(() => expect(app.lastFrame()).toContain('glossary'));
  });

  test('space skips an optional stage, and only those; a refusal stays on the sheet, and esc backs out without advancing', async () => {
    const connection = new FakeConnection();
    connection.replyTo('advanceStage', { ok: false, reason: 'tickets can’t start: its args need {{artifacts.spec}}, and T1 has no spec.' });
    const { app } = await started({ ...factoryState([onLean]), runs: { R1: run } }, { connection });
    app.stdin.write('\r');
    await settle();
    app.stdin.write(CTRL_N);
    await settle();

    await press(app, ' ', DOWN, ' ', DOWN, ' ');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/glossary opus optional · skipped spec opus optional · skipped › tickets opus ← advances here/));
    app.stdin.write('\r');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'advanceStage', taskId: 'T1', skip: ['glossary', 'spec'] }));
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('tickets can’t start'));
    expect(app.lastFrame()).toContain('Advance T1 from grill');

    // Taking a skip back makes that stage the one advanced to again.
    await press(app, UP, ' ');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/glossary opus optional · skipped › spec opus optional ← advances here tickets opus/));

    app.stdin.write('\x1b');
    await eventually(() => expect(app.lastFrame()).not.toContain('Advance T1'));
    expect(connection.sent.filter((command) => command.type === 'advanceStage')).toHaveLength(1);
    expect(connection.sent.filter((command) => command.type === 'interrupt')).toEqual([]);
  });

  test('the advance sheet says when the next stage is the handoff’s, or the last stage is ending; a task without a preset has none', async () => {
    const connection = new FakeConnection();
    const atTickets = { ...onLean, stage: 'tickets' };
    const { app } = await started({ ...factoryState([atTickets]), runs: { R1: run } }, { connection });
    app.stdin.write('\r');
    await settle();
    app.stdin.write(CTRL_N);
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('The next stage, implement, is AFK: hand T1 off to start it.'));

    app.stdin.write('\x1b');
    await settle();
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: { ...onLean, preset: { ...lean, stages: lean.stages.slice(0, 1) } } }]);
    await settle();
    app.stdin.write(CTRL_N);
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('grill is the last stage: advancing puts T1 in review.'));

    app.stdin.write('\x1b');
    await settle();
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: conversing }]);
    await settle();
    app.stdin.write(CTRL_N);
    await settle();
    expect(app.lastFrame()).not.toContain('Advance');
    expect(app.lastFrame()).not.toContain('ctrl+n');
  });

  // ctrl+h as a terminal with the kitty keyboard protocol sends it; Windows
  // Terminal sends Backspace's byte instead, so `/handoff` is the way there.
  const CTRL_H = '\x1b[104;5u';
  const brief = {
    goal: 'Failed webhook deliveries are retried.',
    decided: ['Retry 5xx and timeouts only.'],
    doneWhen: [],
    outOfScope: [],
    links: ['acme/widgets#31'],
  };
  const sheet = {
    brief: null,
    stage: 'implement',
    continueAs: 'resume' as const,
    autonomy: 'L1' as const,
    tier: 'sonnet' as const,
    maxTurns: 300,
    contextShare: 0.23,
    readiness: { blockers: [], toCommit: ['GLOSSARY.md'] },
  };

  test('the agent’s proposal to hand off shows as a banner, and ctrl+h or /handoff opens the handoff sheet, even over an open card', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([onLean]), runs: { R1: run } }, { connection });
    app.stdin.write('\r');
    await settle();
    await eventually(() => expect(app.lastFrame()).toContain('/handoff hand off'));

    connection.servePatch([{ op: 'set', path: ['runs', 'R1'], value: { ...run, proposal: { kind: 'handoff', reason: 'The retry policy is settled.' } } }]);
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('The agent proposes handing off: The retry policy is settled. ctrl+h or /handoff review'));

    app.stdin.write(CTRL_H);
    await eventually(() => expect(connection.sent).toEqual([{ type: 'openHandoff', taskId: 'T1' }]));

    const question = {
      id: 'toolu_1',
      questions: [{ question: 'Retry 4xx too?', header: 'Retries', options: [{ label: 'No', description: '' }], multiSelect: false }],
    };
    connection.servePatch([{ op: 'set', path: ['runs', 'R1'], value: { ...run, question } }]);
    await eventually(() => expect(app.lastFrame()).toContain('Retry 4xx too?'));
    await type(app, '/handoff');
    app.stdin.write('\r');
    await eventually(() => expect(connection.sent).toEqual([{ type: 'openHandoff', taskId: 'T1' }, { type: 'openHandoff', taskId: 'T1' }]));
  });

  test('the sheet waits on the agent’s brief, then the operator edits it, changes continue-as and max turns, and enter hands off', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: sheet }]), runs: { R1: run } }, { connection });
    app.stdin.write('\r');
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('Hand off T1 to implement (AFK)');
      expect(frame).toContain('The agent is writing the brief…');
      expect(frame).toContain('the conversation fills 23% of the context window');
      expect(frame).toContain('The handoff commit takes GLOSSARY.md.');
    });
    // Enter waits for the brief: the operator confirms what they have read.
    app.stdin.write('\r');
    await settle();
    expect(connection.sent).toEqual([]);

    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: { ...onLean, handoff: { ...sheet, brief } } }]);
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/› Goal Failed webhook deliveries are retried\. Decided - Retry 5xx and timeouts only\. \+ Done when \+/));

    await type(app, ' with backoff');
    // Down past the decided item, onto the line that adds one.
    await press(app, DOWN, DOWN);
    await type(app, 'Never 4xx.');
    // Down to the fields, past done when's, out of scope's and links' lines.
    await press(app, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, RIGHT, DOWN, DOWN, '\x7f', '\x7f', '\x7f', '5', '0');
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('- Never 4xx.');
      expect(frame).toContain('Continue as ‹ fresh ›');
      expect(frame).toContain('› Max turns 50');
    });

    app.stdin.write('\r');
    await eventually(() =>
      expect(connection.sent).toEqual([
        {
          type: 'handoff',
          taskId: 'T1',
          brief: { ...brief, goal: 'Failed webhook deliveries are retried. with backoff', decided: ['Retry 5xx and timeouts only.', 'Never 4xx.'] },
          continueAs: 'fresh',
          autonomy: 'L1',
          tier: 'sonnet',
          maxTurns: 50,
        },
      ]),
    );
  });

  test('ctrl+h on a HITL task in the list hands it off from its conversation, a parked one included', async () => {
    const connection = new FakeConnection();
    const parked = { ...onLean, state: 'queued' as const, label: 'Ready for you', liveRunId: null };
    const ended = { ...run, status: 'ended' as const, outcome: 'parked' as const };
    const afk = task('T2', 'Implement the store', 'running', 'Running');
    const { app } = await started({ ...factoryState([parked, afk]), runs: { R1: ended } }, { connection });

    await press(app, DOWN, CTRL_H);
    await settle();
    expect(connection.sent).toEqual([]);
    await press(app, UP, CTRL_H);

    await eventually(() => expect(connection.sent).toEqual([{ type: 'openHandoff', taskId: 'T1' }]));
    await eventually(() => expect(app.lastFrame()).toContain('claude --resume'));
  });

  test('a blocked handoff shows what blocks it, and esc backs out of the sheet to keep talking', async () => {
    const connection = new FakeConnection();
    connection.replyTo('handoff', { ok: false, reason: 'The handoff is blocked. spike is checked out.' });
    const blocked = { ...sheet, brief, readiness: { blockers: ['factory/T1 isn’t checked out in T1’s worktree: spike is.'], toCommit: [] } };
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: blocked }]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection });
    app.stdin.write('\r');
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('✗ factory/T1 isn’t checked out in T1’s worktree: spike is.');
      expect(frame).toContain('Nothing to commit.');
    });

    app.stdin.write('\r');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('The handoff is blocked. spike is checked out.'));
    // The conversation's draft line takes no keys while the sheet is open.
    await type(app, 'x');
    expect(app.lastFrame()).not.toContain('› x');

    app.stdin.write('\x1b');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'closeHandoff', taskId: 'T1' }));
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: onLean }]);
    await eventually(() => expect(app.lastFrame()).not.toContain('Hand off T1'));
    await settle();
    await type(app, 'One more thing');
    app.stdin.write('\r');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'sendMessage', taskId: 'T1', text: 'One more thing' }));
    expect(connection.sent.filter((command) => command.type === 'interrupt')).toEqual([]);
  });
});

describe('answering from Needs you', () => {
  const [CTRL_B, ESC, ENTER] = ['\x02', '\x1b', '\r'];
  const asking = task('T1', 'Fix the login bug', 'waiting', 'Needs you');
  const failing = task('T2', 'Implement the store', 'waiting', 'Needs you');
  const question = {
    id: 'toolu_01',
    questions: [
      {
        question: 'Which identity provider times out?',
        header: 'IdP',
        options: [
          { label: 'Okta', description: 'The workforce SSO' },
          { label: 'Auth0', description: 'The customer login' },
        ],
        multiSelect: false,
      },
    ],
  };
  const asked = {
    kind: 'attention' as const,
    taskId: 'T1',
    repo: 'acme/widgets',
    requestId: 'A1',
    attention: 'question' as const,
    holdsRun: true,
    reason: 'Which identity provider times out?',
    question,
    permission: null,
  };
  const failure = {
    kind: 'attention' as const,
    taskId: 'T2',
    repo: 'acme/widgets',
    requestId: 'A2',
    attention: 'failure' as const,
    holdsRun: false,
    reason: 'The agent hit max turns.',
    question: null,
    permission: null,
  };

  test('the selected item’s answer sheet is the bottom pane, a answers it with a digit at once, and the next item slides under the cursor', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([asking, failing], [failure, asked]), { connection });
    await press(app, '2');
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toMatch(/› T2 Implement the store failure: The agent hit max turns\./);
      expect(frame).toContain('T2 Implement the store ── failure: The agent hit max turns. 1 Retry 2 Take over 3 Cancel a answer');
    });

    await press(app, 'a', '1');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2' }));
    connection.servePatch([{ op: 'set', path: ['attentionQueue'], value: [asked] }]);

    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toMatch(/› T1 Fix the login bug question: Which identity provider times out\?/);
      expect(frame).toMatch(/IdP Which identity provider times out\? 1 Okta The workforce SSO 2 Auth0 The customer login/);
      expect(frame).toContain('digits answer · esc back');
    });
    await press(app, '2');
    await eventually(() =>
      expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', answers: { 'Which identity provider times out?': 'Auth0' } }),
    );
    // Answering, the digits never switched screens.
    expect(app.lastFrame()).toContain('Fix the login bug');
  });

  test('a digit can take a failed AFK task over, into its conversation; esc gives the digits back to the screens', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([asking, failing], [failure, asked]), { connection });
    await press(app, '2', 'a', '2');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'takeOver', taskId: 'T2' }));
    await eventually(() => expect(app.lastFrame()).toContain('ctrl+b back'));
    // Opened on the reply, the conversation takes keys a moment after it shows.
    await settle();
    await press(app, CTRL_B);
    await eventually(() => expect(app.lastFrame()).toContain('digits answer · esc back'));

    await press(app, ESC);
    await eventually(() => expect(app.lastFrame()).toContain('a answer'));
    await press(app, '1');
    await eventually(() => expect(app.lastFrame()).not.toContain('a answer'));
  });

  test('a failed iteration of a loop can be retried, skipped, taken over or cancelled: a digit skips its ticket', async () => {
    const connection = new FakeConnection();
    const looping = { ...failing, loop: { ticket: 'acme/widgets#11', finishing: false } };
    const { app } = await started(factoryState([looping], [failure]), { connection });
    await press(app, '2');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain('failure: The agent hit max turns. 1 Retry 2 Skip acme/widgets#11 3 Take over 4 Cancel a answer'),
    );

    await press(app, 'a', '2');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2', skip: true }));
  });

  test('a failure of a loop’s ticket taken over offers no skip: the operator works it', async () => {
    const takenOver = { ...failing, mode: 'HITL' as const, loop: { ticket: 'acme/widgets#11', finishing: false } };
    const { app } = await started(factoryState([takenOver], [failure]));
    await press(app, '2');

    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('failure: The agent hit max turns. 1 Retry 2 Cancel a answer'));
  });

  test('a stalled loop can be retried once its blockers move, taken over or cancelled', async () => {
    const connection = new FakeConnection();
    const stalled = { ...failing, loop: { ticket: null, finishing: false } };
    const blocked = { ...failure, attention: 'stage-blocked' as const, reason: 'implement’s loop stalled: every open ticket is blocked (acme/widgets#12 by acme/widgets#11).' };
    const { app } = await started(factoryState([stalled], [blocked]), { connection });
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('acme/widgets#11). 1 Retry 2 Take over 3 Cancel a answer'));

    await press(app, 'a', '1');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2' }));
  });

  test('a GitHub write the factory couldn’t make is tried again once the operator answers', async () => {
    const connection = new FakeConnection();
    const cancelled = task('T2', 'Implement the store', 'cancelled', 'Cancelled');
    const unreopened = { ...failure, attention: 'github-write' as const, reason: 'The factory couldn’t reopen acme/widgets#11 on GitHub as its App.' };
    const { app } = await started(factoryState([cancelled], [unreopened]), { connection });
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('as its App. 1 Try again a answer'));

    await press(app, 'a', '1');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2' }));
  });

  test('cancelling a failed task from its sheet asks first when work would be lost', async () => {
    const connection = new FakeConnection();
    const keep = { type: 'cancel' as const, taskId: 'T2', branch: 'keep' as const };
    const choose = [
      { label: 'Keep branch', command: keep },
      { label: 'Discard work', command: { ...keep, branch: 'discard' as const } },
    ];
    connection.replyTo('cancel', { ok: false, reason: 'factory/T2-implement-the-store has 1 commit that exists nowhere else.', choose });
    const { app } = await started(factoryState([failing], [failure]), { connection });

    await press(app, '2', 'a', '3');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'cancel', taskId: 'T2' }));
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('1 Keep branch 2 Discard work'));
    connection.replyTo('cancel', { ok: true });
    await press(app, ENTER);
    await eventually(() => expect(connection.sent.at(-1)).toEqual(keep));
  });

  test('once nothing needs the operator, the digits switch screens again', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([failing], [failure]), { connection });
    await press(app, '2', 'a', '1');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2' }));

    connection.servePatch([
      { op: 'set', path: ['tasks', 'T2'], value: { ...failing, state: 'running', label: 'Running' } },
      { op: 'set', path: ['attentionQueue'], value: [] },
    ]);
    await eventually(() => expect(app.lastFrame()).toContain('Nothing needs you.'));
    await press(app, '1');
    await eventually(() => expect(app.lastFrame()).toMatch(/T2\s+Implement the store\s+Running/));
  });

  test('a refused answer shows its reason and can be answered again; a multi-select toggles with digits and enter confirms', async () => {
    const connection = new FakeConnection();
    connection.replyTo('answer', { ok: false, reason: 'T1 has no open attention request.' });
    const multi = { ...question, questions: [{ ...question.questions[0]!, question: 'Which providers time out?', multiSelect: true }] };
    const { app } = await started(factoryState([asking], [{ ...asked, question: multi }]), { connection });
    await press(app, '2', 'a', '2', '1');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/\[x\] Okta .* \[x\] Auth0/));

    await press(app, ENTER);
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', answers: { 'Which providers time out?': 'Okta, Auth0' } }));
    await eventually(() => expect(app.lastFrame()).toContain('T1 has no open attention request.'));

    await press(app, '2', ENTER);
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', answers: { 'Which providers time out?': 'Auth0' } }));
  });

  const permission = {
    ...failure,
    requestId: 'A3',
    attention: 'permission' as const,
    holdsRun: true,
    reason: 'Bash: npm publish',
    permission: {
      id: 'toolu_1',
      tool: 'Bash',
      summary: 'npm publish',
      rule: 'Bash(npm publish)',
      proposed: [{ part: 'npm publish', rule: 'Bash(npm publish *)' }],
    },
  };

  test('a permission request is allowed once with a digit, or for the task by the rule it proposes, which enter confirms', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([failing], [permission]), { connection });
    await press(app, '2');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain(
        '── T2 Implement the store ── permission: Bash: npm publish 1 Allow once 2 Allow for this task: Bash(npm publish *) 3 Allow always: Bash(npm publish *) 4 Deny with a note a answer',
      ),
    );

    await press(app, 'a', '1');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2', permission: { allow: 'once' } }));
    connection.servePatch([{ op: 'set', path: ['attentionQueue'], value: [{ ...permission, requestId: 'A4' }] }]);
    await settle();
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('npm publish: Bash(npm publish *) enter allows for this task · esc back'));
    expect(connection.sent).toHaveLength(1);
    await press(app, ENTER);
    await eventually(() =>
      expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2', permission: { allow: 'task', rules: ['Bash(npm publish *)'] } }),
    );
  });

  test('Allow for this task offers a rule for each part no rule covers, which the operator edits before enter confirms', async () => {
    const connection = new FakeConnection();
    const chained = {
      ...permission,
      reason: "Bash: npm install zod · sed -i 's/a/b/' src/a.ts",
      permission: {
        id: 'toolu_1',
        tool: 'Bash',
        summary: "npm install zod && sed -i 's/a/b/' src/a.ts && npm test",
        rule: "Bash(npm install zod && sed -i 's/a/b/' src/a.ts && npm test)",
        proposed: [
          { part: 'npm install zod', rule: 'Bash(npm install *)' },
          { part: "sed -i 's/a/b/' src/a.ts", rule: 'Bash(sed -i *)' },
        ],
      },
    };
    const { app } = await started(factoryState([failing], [chained]), { connection });
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('2 Allow for this task: Bash(npm install *), Bash(sed -i *)'));

    await press(app, 'a', '2');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain(
        "› npm install zod: Bash(npm install *) sed -i 's/a/b/' src/a.ts: Bash(sed -i *) ↑↓ field · enter allows for this task · esc back",
      ),
    );
    await press(app, DOWN, ...Array(6).fill('\x7f'));
    app.stdin.write(' *)');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain("› sed -i 's/a/b/' src/a.ts: Bash(sed *)"));
    await press(app, ENTER);
    await eventually(() =>
      expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2', permission: { allow: 'task', rules: ['Bash(npm install *)', 'Bash(sed *)'] } }),
    );
  });

  test('Allow for this task sends nothing while every rule is blank, and esc backs out of the rules', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([failing], [permission]), { connection });
    await press(app, '2', 'a', '2', ...Array('Bash(npm publish *)'.length).fill('\x7f'), ENTER);
    await settle();
    expect(connection.sent).toEqual([]);

    await press(app, ESC);
    await eventually(() => expect(app.lastFrame()).not.toContain('enter allows for this task'));
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('npm publish: Bash(npm publish *)'));
  });

  test('Allow always offers the rules Allow for this task does, editable, and enter sends them for every task', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([failing], [permission]), { connection });
    await press(app, '2', 'a', '3');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('npm publish: Bash(npm publish *) enter allows always · esc back'));

    await press(app, ...Array(' publish *)'.length).fill('\x7f'));
    app.stdin.write(' *)');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('npm publish: Bash(npm *)'));
    await press(app, ENTER);
    await eventually(() =>
      expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2', permission: { allow: 'always', rules: ['Bash(npm *)'] } }),
    );
  });

  test('Deny takes a typed note, which enter sends and esc sets aside', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([failing], [permission]), { connection });
    await press(app, '2', 'a', '4');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('Note for the agent: enter denies · esc back'));

    await press(app, ESC);
    await eventually(() => expect(app.lastFrame()).toContain('4 Deny with a note'));
    // The digits still answer: esc left only the note.
    await press(app, '4');
    await eventually(() => expect(app.lastFrame()).toContain('Note for the agent:'));
    // An empty note sends nothing.
    await press(app, ENTER);
    await settle();
    expect(connection.sent).toEqual([]);

    app.stdin.write('Use 2 tags');
    await eventually(() => expect(app.lastFrame()).toContain('Note for the agent: Use 2 tags'));
    await press(app, ENTER);
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2', permission: { deny: 'Use 2 tags' } }));
  });

  const reviewing = task('T3', 'Add a logout button', 'in-review', 'In review');
  const review = { kind: 'review' as const, taskId: 'T3' };

  test('a root in review offers Request changes, Mark done and Cancel, and Request changes sends the typed review comments', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([reviewing], [review]), { connection });
    await press(app, '2');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain('── T3 Add a logout button ── In review 1 Request changes 2 Mark done 3 Cancel a answer'),
    );

    await press(app, 'a', '1');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('Review comments: enter requests changes · esc back'));
    app.stdin.write('Put it in the header');
    await eventually(() => expect(app.lastFrame()).toContain('Review comments: Put it in the header'));
    await press(app, ENTER);
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'requestChanges', taskId: 'T3', comments: 'Put it in the header' }));
  });

  test('Mark done on an unmerged branch asks “Finish anyway?”: y finishes it, n backs out', async () => {
    const connection = new FakeConnection();
    const confirm = { type: 'markDone' as const, taskId: 'T3', anyway: true };
    connection.replyTo('markDone', { ok: false, reason: 'Not merged into main: factory/T3-add-a-logout-button’s tip isn’t on origin/main. Finish anyway?', confirm });
    const { app } = await started(factoryState([reviewing], [review]), { connection });
    await press(app, '2', 'a', '2');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'markDone', taskId: 'T3' }));
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain('Not merged into main: factory/T3-add-a-logout-button’s tip isn’t on origin/main. Finish anyway? y yes · n no'),
    );

    await press(app, 'n');
    await eventually(() => expect(app.lastFrame()).not.toContain('Finish anyway?'));
    expect(connection.sent).toHaveLength(1);

    await press(app, '2');
    await eventually(() => expect(app.lastFrame()).toContain('Finish anyway?'));
    connection.replyTo('markDone', { ok: true });
    await press(app, 'y');
    await eventually(() => expect(connection.sent.at(-1)).toEqual(confirm));
    await eventually(() => expect(app.lastFrame()).not.toContain('Finish anyway?'));
  });

  test('Cancel on a root whose branch holds work asks Keep branch or Discard work, and a digit picks one', async () => {
    const connection = new FakeConnection();
    const discard = { type: 'cancel' as const, taskId: 'T3', branch: 'discard' as const };
    connection.replyTo('cancel', {
      ok: false,
      reason: 'factory/T3-add-a-logout-button has 2 commits that exist nowhere else.',
      choose: [
        { label: 'Keep branch', command: { type: 'cancel', taskId: 'T3', branch: 'keep' } },
        { label: 'Discard work', command: discard },
      ],
    });
    const { app } = await started(factoryState([reviewing], [review]), { connection });
    await press(app, '2', 'a', '3');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain(
        'factory/T3-add-a-logout-button has 2 commits that exist nowhere else. 1 Keep branch 2 Discard work enter Keep branch · esc back',
      ),
    );

    connection.replyTo('cancel', { ok: true });
    await press(app, '2');
    await eventually(() => expect(connection.sent.at(-1)).toEqual(discard));
    await eventually(() => expect(app.lastFrame()).not.toContain('Discard work'));
  });

  test('a missing repository takes no digits, and its sheet says how to fix it', async () => {
    const connection = new FakeConnection();
    const missing = { ...failure, taskId: null, requestId: 'A3', attention: 'repo-missing' as const, reason: 'The clone of acme/widgets is no longer at /clones/widgets.' };
    const { app } = await started(factoryState([], [missing]), { connection });
    await press(app, '2', 'a', '1');

    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('── acme/widgets ── repo-missing: The clone of acme/widgets is no longer at /clones/widgets. Put the clone back'));
    expect(connection.sent).toEqual([]);
  });
});

describe('answering in the conversation', () => {
  const [ESC, ENTER] = ['\x1b', '\r'];
  const waiting: TaskView = { ...task('T1', 'Implement acme/widgets#12', 'waiting', 'Needs you'), liveRunId: 'R1' };
  const suspended = {
    id: 'R1',
    taskId: 'T1',
    mode: 'AFK' as const,
    autonomy: 'L1' as const,
    status: 'suspended' as const,
    outcome: null,
    turn: 'agent' as const,
    queued: [] as string[],
    question: null,
    permission: null,
    stage: 'implement',
    ticket: null,
    proposal: null,
    tier: 'sonnet' as const,
    model: 'claude-sonnet-5-5',
    maxTurns: 300,
    cli: { pid: 4242, createdAt: 1 },
    skillSet: null,
    startedAt: 1,
    endedAt: null,
  };
  const permission = {
    kind: 'attention' as const,
    taskId: 'T1',
    repo: 'acme/widgets',
    requestId: 'A1',
    attention: 'permission' as const,
    holdsRun: true,
    reason: 'Bash: gh issue view 12',
    question: null,
    permission: { id: 'toolu_1', tool: 'Bash', summary: 'gh issue view 12', rule: 'Bash(gh issue view 12)' },
  };

  // Opens the task's conversation from the Tasks tab.
  async function opened(item: FactoryState['attentionQueue'][number], connection = new FakeConnection()) {
    const { app } = await started({ ...factoryState([waiting], [item]), runs: { R1: suspended } }, { connection });
    await press(app, ENTER);
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    return app;
  }

  test('an AFK task that needs the operator shows its request in its conversation, and a digit answers it there', async () => {
    const connection = new FakeConnection();
    const app = await opened(permission, connection);
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('permission: Bash: gh issue view 12 1 Allow once 2 Allow for this task: Bash(gh issue view 12) 3 Allow always: Bash(gh issue view 12) 4 Deny with a note');
      expect(frame).toContain('digits answer · c take over · ctrl+b back');
      expect(frame).not.toContain('esc back');
    });

    // A request stored before rules were proposed per part proposes the call's own.
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('gh issue view 12: Bash(gh issue view 12) enter allows for this task · esc back'));
    await press(app, ENTER);
    await eventually(() =>
      expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', permission: { allow: 'task', rules: ['Bash(gh issue view 12)'] } }),
    );
    // Still in the conversation, which follows the run as it resumes.
    expect(app.lastFrame()).toContain('ctrl+b back');
  });

  test('Deny takes a typed note in the conversation, which esc sets aside and enter sends', async () => {
    const connection = new FakeConnection();
    const app = await opened(permission, connection);
    await press(app, '4');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('Note for the agent: enter denies · esc back'));
    await press(app, ESC);
    await eventually(() => expect(app.lastFrame()).not.toContain('Note for the agent'));

    await press(app, '4');
    app.stdin.write('Read it from the brief');
    await settle();
    await press(app, ENTER);
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', permission: { deny: 'Read it from the brief' } }));
  });

  test('a long request stays whole on a full screen: the events give way, not the sheet', async () => {
    const command = 'for f in src/lifecycle/lifecycle.ts src/daemon/daemon.ts src/protocol/protocol.ts src/tui/app.ts; do sed -i s/a/b/ $f; done';
    const long = {
      ...permission,
      reason: `Bash: ${command}`,
      permission: {
        id: 'toolu_1',
        tool: 'Bash',
        summary: command,
        rule: `Bash(${command})`,
        proposed: [
          { part: 'for f in …', rule: 'Bash(for f *)' },
          { part: 'sed -i s/a/b/ $f', rule: 'Bash(do sed *)' },
          { part: 'done', rule: 'Bash(done *)' },
        ],
      },
    };
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([waiting], [long]), runs: { R1: suspended } }, { connection });
    Object.defineProperty(app.stdout, 'rows', { value: 20 });
    await press(app, ENTER);
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    connection.serveConversation(
      'R1',
      ...Array.from({ length: 30 }, (_, i) => ({ type: 'message' as const, id: `E${i}`, from: 'agent' as const, text: `Step ${i}.` })),
    );
    await settle();
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain(`permission: Bash: ${command} 1 Allow once 2 Allow for this task: Bash(for f *), Bash(do sed *), Bash(done *) 3`);
      expect(frame).toContain('digits answer · c take over · ctrl+b back');
      expect(frame).toContain('Step 29.');
      expect(frame).not.toContain('Step 0.');
    });
  });

  test('a question request shows its card in the conversation, and a digit answers it', async () => {
    const connection = new FakeConnection();
    const question = {
      id: 'toolu_02',
      questions: [
        {
          question: 'Which endpoint?',
          header: 'API',
          options: [
            { label: 'v1', description: 'The old one' },
            { label: 'v2', description: 'The new one' },
          ],
          multiSelect: false,
        },
      ],
    };
    const app = await opened({ ...permission, attention: 'question', reason: 'Which endpoint?', question, permission: null }, connection);
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/API Which endpoint\? 1 v1 The old one 2 v2 The new one/));

    await press(app, '2');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', answers: { 'Which endpoint?': 'v2' } }));
  });

  test('a refused answer shows its reason in the conversation and can be answered again', async () => {
    const connection = new FakeConnection();
    connection.replyTo('answer', { ok: false, reason: 'T1 has no open attention request.' });
    const app = await opened(permission, connection);
    await press(app, '1');
    await eventually(() => expect(app.lastFrame()).toContain('T1 has no open attention request.'));

    await press(app, '1');
    await eventually(() => expect(connection.sent.filter((command) => command.type === 'answer')).toHaveLength(2));
  });
});

describe('taking over with c', () => {
  const [CTRL_B, ENTER] = ['\x02', '\r'];
  const running: TaskView = { ...task('T1', 'Implement acme/widgets#12', 'running', 'Running'), liveRunId: 'R1' };
  const afkRun = {
    id: 'R1',
    taskId: 'T1',
    mode: 'AFK' as const,
    autonomy: 'L1' as const,
    status: 'active' as const,
    outcome: null,
    turn: 'agent' as const,
    queued: [] as string[],
    question: null,
    permission: null,
    stage: 'implement',
    ticket: null,
    proposal: null,
    tier: 'sonnet' as const,
    model: 'claude-sonnet-5-5',
    maxTurns: 300,
    cli: { pid: 4242, createdAt: 1 },
    skillSet: null,
    startedAt: 1,
    endedAt: null,
  };
  const permission = {
    kind: 'attention' as const,
    taskId: 'T2',
    repo: 'acme/widgets',
    requestId: 'A1',
    attention: 'permission' as const,
    holdsRun: true,
    reason: 'Bash: npm publish',
    question: null,
    permission: { id: 'toolu_1', tool: 'Bash', summary: 'npm publish', rule: 'Bash(npm publish)' },
  };

  test('c on an AFK task in the list takes it over, into its conversation', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([running]), runs: { R1: afkRun } }, { connection });
    await eventually(() => expect(app.lastFrame()).toContain('c converse or take over'));

    await press(app, 'c');

    await eventually(() => expect(connection.sent).toEqual([{ type: 'takeOver', taskId: 'T1' }]));
    await eventually(() => expect(app.lastFrame()).toContain('ctrl+b back'));
  });

  test('a refused takeover says why and stays on the list', async () => {
    const connection = new FakeConnection();
    connection.replyTo('takeOver', { ok: false, reason: 'Only a live AFK task (queued, running or needing you) can be taken over.' });
    const { app } = await started(factoryState([task('T1', 'Implement the store', 'in-review', 'In review')]), { connection });

    await press(app, 'c');

    await eventually(() => expect(app.lastFrame()).toContain('Only a live AFK task (queued, running or needing you) can be taken over.'));
    expect(app.lastFrame()).toContain('1 Tasks');
  });

  test('c on a HITL task converses: it opens the conversation and sends nothing', async () => {
    const connection = new FakeConnection();
    const hitl = { ...task('T1', 'Grill me about the login flow.', 'running', 'In conversation', 'HITL'), liveRunId: 'R1' };
    const { app } = await started({ ...factoryState([hitl]), runs: { R1: { ...afkRun, mode: 'HITL' as const, autonomy: null } } }, { connection });

    await press(app, 'c');

    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    expect(connection.sent).toEqual([]);
  });

  test('c on a Needs you item takes its task over, while its answer sheet has the digits too', async () => {
    const connection = new FakeConnection();
    const waiting = { ...task('T2', 'Publish the package', 'waiting', 'Needs you'), liveRunId: 'R1' };
    const { app } = await started({ ...factoryState([waiting], [permission]), runs: { R1: { ...afkRun, taskId: 'T2', status: 'suspended' as const } } }, { connection });

    await press(app, '2', 'a', 'c');

    await eventually(() => expect(connection.sent).toEqual([{ type: 'takeOver', taskId: 'T2' }]));
    await eventually(() => expect(app.lastFrame()).toContain('ctrl+b back'));
  });

  test('c in an AFK task’s conversation takes it over, and the conversation takes chat once the HITL run is live', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([running]), runs: { R1: afkRun } }, { connection });
    await press(app, ENTER);
    await eventually(() => expect(app.lastFrame()).toContain('AFK runs take no chat: c takes it over to talk to it · ctrl+b back'));

    await press(app, 'c');
    await eventually(() => expect(connection.sent).toEqual([{ type: 'takeOver', taskId: 'T1' }]));
    connection.servePatch([
      { op: 'set', path: ['runs', 'R1'], value: { ...afkRun, status: 'ended', outcome: 'taken over' } },
      { op: 'set', path: ['runs', 'R2'], value: { ...afkRun, id: 'R2', mode: 'HITL', autonomy: null, turn: 'operator' } },
      { op: 'set', path: ['tasks', 'T1'], value: { ...running, mode: 'HITL', autonomy: null, label: 'Ready for you', liveRunId: 'R2' } },
    ]);

    await eventually(() => expect(connection.conversed).toEqual(['R1', 'R2']));
    await eventually(() => expect(app.lastFrame()).toContain('The agent is waiting on you.'));
    await press(app, CTRL_B);
    await eventually(() => expect(app.lastFrame()).toContain('1 Tasks'));
  });

  test('c in the conversation of an AFK task that needs the operator takes it over from its answer sheet', async () => {
    const connection = new FakeConnection();
    const waiting = { ...task('T2', 'Publish the package', 'waiting', 'Needs you'), liveRunId: 'R1' };
    const { app } = await started({ ...factoryState([waiting], [permission]), runs: { R1: { ...afkRun, taskId: 'T2', status: 'suspended' as const } } }, { connection });
    await press(app, ENTER);
    await eventually(() => expect(app.lastFrame()).toContain('digits answer · c take over · ctrl+b back'));

    await press(app, 'c');

    await eventually(() => expect(connection.sent).toEqual([{ type: 'takeOver', taskId: 'T2' }]));
  });
});

describe('the conversation of an AFK task that is no longer live', () => {
  test('offers no takeover: an In review task’s view says only that it takes no chat', async () => {
    const connection = new FakeConnection();
    const reviewed = task('T1', 'Implement acme/widgets#12', 'in-review', 'In review');
    const ended = {
      id: 'R1', taskId: 'T1', mode: 'AFK' as const, autonomy: 'L1' as const, status: 'ended' as const, outcome: 'completed' as const,
      turn: 'agent' as const, queued: [] as string[], question: null, permission: null, stage: 'implement', ticket: null, proposal: null,
      tier: 'sonnet' as const, model: 'claude-sonnet-5-5', maxTurns: 300, cli: null, skillSet: null, startedAt: 1, endedAt: 2,
    };
    const { app } = await started({ ...factoryState([reviewed]), runs: { R1: ended } }, { connection });
    await press(app, '\r');
    await eventually(() => expect(app.lastFrame()).toContain('AFK runs take no chat · ctrl+b back'));

    await press(app, 'c');

    expect(connection.sent).toEqual([]);
  });
});
