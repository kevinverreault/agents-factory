// Seam 2: the TUI against an in-memory fake protocol client.
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { ConversationEvent } from '../executor/executor.ts';
import type { Edited } from '../os/edit-externally.ts';
import type { FactoryState, RunView, TaskView } from '../protocol/factory-state.ts';
import type { LeftoversView, PresetsView } from '../protocol/protocol.ts';
import { FakeConnection } from '../testing/fake-connection.ts';
import { App } from './app.ts';
import { GLYPH } from './theme.ts';
import { GcSheet } from './gc-sheet.ts';
import { memoryPrefs, type PrefsStore } from './prefs.ts';

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

// While a launch waits on the daemon, the screen shows 'Naming the task…'
// after a spinner that turns, and a second enter sends no second launch.
async function spinsWhileLaunching(app: { lastFrame(): string | undefined; stdin: { write(data: string): void } }, connection: FakeConnection) {
  const frames = new RegExp(`([${GLYPH.spinner.join('')}]) Naming the task…`);
  const spinner = () => app.lastFrame()!.match(frames)?.[1];
  await eventually(() => expect(spinner()).toBeDefined());
  const first = spinner();
  await eventually(() => expect(spinner()).not.toBe(first));
  app.stdin.write('\r');
  await settle();
  expect(connection.sent.filter((command) => command.type === 'launchTask')).toHaveLength(1);
}

// The screen shows `label` after a spinner that turns.
async function turns(app: { lastFrame(): string | undefined }, label: string) {
  const frames = new RegExp(`([${GLYPH.spinner.join('')}]) ${label}`);
  const spinner = () => app.lastFrame()!.match(frames)?.[1];
  await eventually(() => expect(spinner()).toBeDefined());
  const first = spinner();
  await eventually(() => expect(spinner()).not.toBe(first));
}

function task(id: string, title: string, state: TaskView['state'], label: string, mode: TaskView['mode'] = 'AFK'): TaskView {
  return { id, title, repo: 'acme/widgets', parent: null, depth: 0, child: null, progress: null, rollup: null, kind: 'plain', ticket: null, mergePolicy: null, resolving: null, specTask: null, ticketSet: null, mode, autonomy: mode === 'AFK' ? 'L1' : null, priority: 'normal', groups: [], state, label, liveRunId: null, branch: null, worktree: null, sessionId: null, skillSet: null, preset: null, stage: null, tier: 'sonnet', allowRules: [], egressHosts: [], goal: null, handoff: null, quick: null, loop: null, launchSummary: null, prBody: null, prTitle: null, publishing: null, pr: null, pushed: false, cleanup: null, transcripts: null };
}

function factoryState(tasks: TaskView[], attentionQueue: FactoryState['attentionQueue'] = []): FactoryState {
  return {
    repositories: {},
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    runs: {},
    artifacts: {},
    attentionQueue,
    slots: { active: 0, cap: 2 },
    keepAwake: true,
    lastUsedRepo: null,
    usage: { window: null, weekly: null, tokensPerHour: Array(12).fill(0) },
  };
}

async function started(
  state?: FactoryState,
  { cwd, connection = new FakeConnection(), prefs, editText }: { cwd?: string; connection?: FakeConnection; prefs?: PrefsStore; editText?: (text: string) => Promise<Edited> } = {},
) {
  if (state) connection.serveSnapshot(state);
  const app = render(<App connection={connection} cwd={cwd} prefs={prefs ?? memoryPrefs()} editText={editText} />);
  apps.push(app);
  await settle();
  return { connection, app };
}

// The terminal's width, which a test's stdout fixes at 100 columns otherwise.
function widen(app: { stdout: NodeJS.EventEmitter }, columns: number) {
  Object.defineProperty(app.stdout, 'columns', { value: columns, configurable: true });
  app.stdout.emit('resize');
}

// A terminal of `rows` rows, which the TUI fits itself to.
function resize(app: { stdout: NodeJS.EventEmitter }, rows: number) {
  Object.defineProperty(app.stdout, 'rows', { value: rows, configurable: true });
  app.stdout.emit('resize');
}

// The frame's lines.
const lines = (app: { lastFrame(): string | undefined }) => app.lastFrame()!.split('\n');

describe('the frame', () => {

  test('the header names the factory and its tabs, and the breadcrumb says where you are', async () => {
    const { app } = await started(
      factoryState([{ ...task('T1', 'Settle the glossary', 'queued', 'Ready for you', 'HITL'), groups: ['docs'] }, task('T2', 'Implement the store', 'running', 'Running')]),
    );

    await eventually(() => {
      expect(lines(app)[0]).toMatch(/^agents-factory\s+1 Tasks\s+2 Needs you \(0\)\s+3 Runs\s+4 Usage/);
      expect(app.lastFrame()).toContain('Tasks · group: all');
    });

    // The newest task is the top row.
    await press(app, '\r');
    await eventually(() => expect(app.lastFrame()).toContain('Tasks › T2 Implement the store'));

    await press(app, '\x1b', ':', ...'group docs', '\r');
    await eventually(() => expect(app.lastFrame()).toContain('Tasks · group: docs'));
  });

  test('rules divide the header, breadcrumb, body, strip and footer, and the screen’s keys are its last line, under the strip', async () => {
    const { app } = await started(factoryState([task('T1', 'Implement the store', 'running', 'Running')]));

    await eventually(() => {
      const frame = lines(app);
      expect(frame.filter((line) => /^─{20,}$/.test(line.trim()))).toHaveLength(4);
      // The footer: the lines under the last rule, on as many as it wraps onto.
      const footer = frame.slice(frame.findLastIndex((line) => /^─{20,}$/.test(line)) + 1);
      expect(footer.join(' ').replace(/\s+/g, ' ')).toMatch(/^enter detail · c converse or take over .*· g group .*· \? keys$/);
      expect(footer[0]).toMatch(/·$/);
      expect(frame.at(-footer.length - 2)).toMatch(/^window unknown/);
    });

    await press(app, '3');
    await eventually(() => expect(lines(app).at(-1)).toMatch(/^enter its task’s detail/));

    // A task's detail offers a answer only for a request it has.
    await press(app, '1', '\r');
    await eventually(() => expect(lines(app).at(-1)).toMatch(/^enter open conversation/));
    expect(lines(app).at(-1)).not.toContain('a answer');

    // While a sheet holds the keys, the footer gives way to the sheet's own hint.
    await press(app, '\x1b', 'g');
    await eventually(() => expect(app.lastFrame()).toContain('enter filters the tasks · esc back'));
    expect(app.lastFrame()).not.toContain('enter detail');
  });

  test('the TUI takes the terminal’s full height at startup, its footer on the bottom line whatever the screen holds', async () => {
    const { app } = await started(factoryState([task('T1', 'Implement the store', 'running', 'Running')]));
    // A tall terminal, far taller than what the screens hold.
    resize(app, 40);

    for (const keys of [[], ['2'], ['3'], ['4'], ['1', '\r']]) {
      await press(app, ...keys);
      await eventually(() => {
        const frame = lines(app);
        expect(frame).toHaveLength(40);
        // The footer: its keys under the last rule, ending on the last line.
        expect(frame.at(-1)).toMatch(/\? keys$/);
        expect(frame.findLastIndex((line) => /^─{20,}$/.test(line))).toBeGreaterThanOrEqual(frame.length - 3);
      });
    }
  });

  test('under NO_COLOR nothing is coloured, on any screen, sheet or view', async () => {
    const level = chalk.level;
    chalk.level = 3;
    vi.stubEnv('NO_COLOR', '1');
    onTestFinished(() => {
      chalk.level = level;
      vi.unstubAllEnvs();
    });
    // Any foreground or background colour, of the 16, the 256 or truecolour.
    const COLOURED = /\x1b\[(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])(?:;[\d;]*)?m/;
    const failed: FactoryState['attentionQueue'][number] = {
      kind: 'attention', recovery: null, deniedHosts: null, skipped: null, taskId: 'T3', repo: 'acme/widgets', requestId: 'A1', attention: 'failure', holdsRun: false, reason: 'The agent hit max turns.', question: null, permission: null,
    };
    const { app } = await started(
      factoryState([task('T1', 'Implement the store', 'running', 'Running'), task('T2', 'Settle the glossary', 'done', 'Done'), task('T3', 'Write the docs', 'waiting', 'Needs you')], [failed]),
    );

    await eventually(() => expect(app.lastFrame()).toContain('Implement the store'));
    expect(app.lastFrame()).not.toMatch(COLOURED);
    // The answer sheet, the Runs and Usage screens, a detail, the condensed view and help.
    for (const [keys, shows] of [[['2'], 'FAILURE'], [['3'], 'No runs yet.'], [['4'], '5-hour window'], [['1', '\r'], 'Tasks › T3'], [['v'], 'DETAIL'], [['?'], 'KEYS']] as const) {
      await press(app, ...keys);
      await eventually(() => expect(app.lastFrame()!.replace(/\x1b\[[\d;]*m/g, '')).toContain(shows));
      expect(app.lastFrame()).not.toMatch(COLOURED);
    }
  });
});

describe('task rows', () => {
  const rowOf = (app: { lastFrame(): string | undefined }, id: string) => app.lastFrame()!.split('\n').find((line) => new RegExp(`\\s${id}\\s`).test(line));
  const looping = (): FactoryState =>
    factoryState([
      {
        ...task('T1', 'Implement the store', 'running', 'Running'),
        autonomy: 'L2',
        groups: ['store', 'billing'],
        progress: 'On the migrations',
        rollup: { done: 1, running: 0, needsYou: 0, cancelled: 0, failed: [] },
      },
      { ...task('T2', 'Write the migrations', 'done', 'Done'), parent: 'T1', depth: 1 },
      task('T3', 'Grill me on the docs', 'queued', 'Ready for you', 'HITL'),
      task('T4', 'Drop the old schema', 'cancelled', 'Cancelled'),
      task('T5', 'Wait for the children', 'awaiting-children', 'Waiting on children'),
    ]);

  test('a row shows its state’s glyph, its id and title, mode and autonomy, state, extras and groups, the cursor on the selected one', async () => {
    const { app } = await started(looping());

    await eventually(() => {
      expect(rowOf(app, 'T1')).toMatch(/^\s+●\s+T1\s+Implement the store\s+AFK L2\s+Running\s+\[1 done\] · On the migrations\s+store, billing$/);
      expect(rowOf(app, 'T2')).toMatch(/^\s+✓\s+T2\s+Write the migrations\s+AFK L1\s+Done/);
      expect(rowOf(app, 'T3')).toMatch(/^\s+◆\s+T3\s+Grill me on the docs\s+HITL\s+Ready for you/);
      expect(rowOf(app, 'T4')).toMatch(/^\s+✕\s+T4\s+Drop the old schema\s+AFK L1\s+Cancelled/);
      // The cursor starts on the newest task.
      expect(rowOf(app, 'T5')).toMatch(/^›\s+⧗\s+T5/);
    });
    // A child sits indented under its parent: its glyph past the root’s.
    expect(rowOf(app, 'T2')!.indexOf('✓')).toBeGreaterThan(rowOf(app, 'T1')!.indexOf('●'));
    // The tier is the detail’s, not the row’s.
    expect(rowOf(app, 'T1')).not.toContain('sonnet');
  });

  test('on a narrower terminal a row drops its groups first, then its extras', async () => {
    const { app } = await started(looping());
    widen(app, 95);
    await eventually(() => {
      expect(rowOf(app, 'T1')).toMatch(/Running\s+\[1 done\] · On the migrations$/);
      expect(rowOf(app, 'T1')).not.toContain('billing');
    });

    widen(app, 80);
    await eventually(() => expect(rowOf(app, 'T1')).toMatch(/Implement the store\s+AFK L2\s+Running$/));
  });
});

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
      expect(frame).toMatch(/T1\s+Settle the glossary\s+HITL\s+Ready for you/);
      expect(frame).toMatch(/T2\s+Implement the store\s+AFK L1\s+Running/);
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
            recovery: null,
            deniedHosts: null, skipped: null,
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
      expect(frame).toMatch(/failure\s+T2\s+Implement the store\s+The agent hit max turns\./);
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

    await eventually(() => expect(app.lastFrame()).toMatch(/T1\s+Implement the store\s+AFK L1\s+In review/));
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
  test('a task’s detail shows the tier its next run starts at, and t moves the selected task to the next tier', async () => {
    const { app, connection } = await started(
      factoryState([task('T1', 'Settle the glossary', 'queued', 'Ready for you', 'HITL'), task('T2', 'Implement the store', 'running', 'Running')]),
    );
    await eventually(() => expect(app.lastFrame()).toMatch(/T2\s+Implement the store\s+AFK L1\s+Running/));
    expect(app.lastFrame()).toContain('t re-tier');

    // T2, the newest, is selected first.
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
    await press(app, '\r');
    await eventually(() => expect(app.lastFrame()).toMatch(/AFK L1 · .*opus · Running/));
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

    // T2, the newest, is selected first.
    await press(app, 'x');

    await eventually(() => expect(connection.sent).toEqual([{ type: 'cancel', taskId: 'T2' }]));
  });

  test('when work would be lost, the cancel sheet asks once: enter keeps the branch, 2 discards the work, esc backs out', async () => {
    const { app, connection } = await started(tasks());
    connection.replyTo('cancel', { ok: false, reason: 'factory/T2-implement-the-store has 1 commit that exists nowhere else.', choose });
    await press(app, 'x');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain(
        'CANCEL T2 factory/T2-implement-the-store has 1 commit that exists nowhere else. [1] Keep branch [2] Discard work enter Keep branch · esc back',
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

describe('the task tree', () => {
  const failure = (taskId: string): FactoryState['attentionQueue'][number] => ({
    kind: 'attention',
    recovery: null,
    deniedHosts: null, skipped: null,
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
          progress: 'Wiring the header.',
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
    // As wide as the TUI is designed for: the root's extras whole.
    widen(app, 120);

    await eventually(() => {
      // The tree's rows, which start with their task's glyph and id.
      const rows = app.lastFrame()!.split('\n').filter((line) => /^[›\s]+\S\s+T\d/.test(line));
      // Newest first: the roots, and each parent's children under it.
      expect(rows.map((row) => /T\d/.exec(row)![0])).toEqual(['T5', 'T1', 'T3', 'T4', 'T2']);
      // Each child's glyph sits indented past its parent's.
      const glyphAt = rows.map((row) => row.search(/[^›\s]/));
      expect(glyphAt[1]).toBe(glyphAt[0]);
      expect(glyphAt[2]).toBeGreaterThan(glyphAt[1]!);
      expect(glyphAt[3]).toBeGreaterThan(glyphAt[2]!);
      expect(glyphAt[4]).toBe(glyphAt[2]);
      expect(unwrapped(app.lastFrame()!)).toMatch(/T1 +Add a logout button +AFK L1 +Running +\[2 running, 1 needs you\] · T2 failed · Wiring the header\./);
      expect(unwrapped(app.lastFrame()!)).toMatch(/! T2 +Survey sign-out +AFK L1 +Needs you/);
      expect(unwrapped(app.lastFrame()!)).toMatch(/T3 +Write the docs +AFK L1 +Running +\[1 done\]/);
      expect(unwrapped(app.lastFrame()!)).toMatch(/✓ T4 +Check the links +AFK L1 +Done/);
    });
  });

  test('a failed child is retried with y from the tree, re-tiered with t, taken over with c and cancelled with x', async () => {
    const { app, connection } = await started(tree());
    // T2 is the last row: T5, T1, T3, T4, T2.
    await press(app, '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B');
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

describe('spec tasks', () => {
  // T1, a spec task over #10, with ticket tasks T2 on #11 (In review), T3
  // on #15 (Running) with a child T5, and T4 on #16 (Done); #12 waits on
  // #11, #13 is held back, #14 was skipped and #17 is about to launch. T6
  // is a root launched after.
  const specTree = () =>
    factoryState([
      {
        ...task('T1', 'Sign-in', 'running', 'Running'),
        kind: 'spec',
        mergePolicy: 'operator',
        ticketSet: {
          spec: 'acme/widgets#10',
          tickets: [
            { ref: 'acme/widgets#11', title: 'A login form', state: 'launched', taskId: 'T2' },
            { ref: 'acme/widgets#12', title: 'Remember me', state: 'waiting', blockers: ['acme/widgets#11'] },
            { ref: 'acme/widgets#13', title: 'SSO', state: 'held-back' },
            { ref: 'acme/widgets#14', title: 'The sign-in route', state: 'skipped' },
            { ref: 'acme/widgets#15', title: 'Sign out', state: 'launched', taskId: 'T3' },
            { ref: 'acme/widgets#16', title: 'Lock out', state: 'merged', taskId: 'T4' },
            { ref: 'acme/widgets#17', title: 'Audit log', state: 'launching' },
          ],
          problem: null,
        },
      },
      { ...ticketTask('T2', 'A login form', 'acme/widgets#11'), state: 'in-review', label: 'In review' },
      { ...ticketTask('T3', 'Sign out', 'acme/widgets#15'), rollup: { done: 0, running: 1, needsYou: 0, cancelled: 0, failed: [] } },
      { ...ticketTask('T4', 'Lock out', 'acme/widgets#16'), state: 'done', label: 'Done' },
      { ...task('T5', 'Check the links', 'running', 'Running'), parent: 'T3', depth: 1 },
      task('T6', 'Another root', 'queued', 'Queued'),
    ]);

  function ticketTask(id: string, title: string, ticket: string): TaskView {
    return { ...task(id, title, 'running', 'Running'), kind: 'ticket', ticket, specTask: 'T1', mergePolicy: 'operator' };
  }

  test('ticket tasks show under their spec task, which counts its tickets by state, each ticket task naming its ticket', async () => {
    const { app } = await started(specTree());
    widen(app, 140);

    await eventually(() => {
      const rows = lines(app).filter((line) => /^[›\s]+\S\s+T\d/.test(line));
      // Newest first: the roots, and each spec task's ticket tasks under it, as children are.
      expect(rows.map((row) => /T\d/.exec(row)![0])).toEqual(['T6', 'T1', 'T4', 'T3', 'T5', 'T2']);
      const glyphAt = rows.map((row) => row.search(/[^›\s]/));
      expect(glyphAt[1]).toBe(glyphAt[0]);
      expect(glyphAt[2]).toBeGreaterThan(glyphAt[1]!);
      expect(glyphAt[3]).toBe(glyphAt[2]);
      // A ticket task's child sits past its ticket task.
      expect(glyphAt[4]).toBeGreaterThan(glyphAt[3]!);
      expect(glyphAt[5]).toBe(glyphAt[2]);
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toMatch(/T1 +Sign-in +AFK L1 +Running +\[1 merged, 3 in flight, 1 waiting, 1 held back, 1 skipped\]/);
      expect(frame).toMatch(/T2 +A login form +AFK L1 +In review +on acme\/widgets#11/);
      expect(frame).toMatch(/T3 +Sign out +AFK L1 +Running +on acme\/widgets#15 · \[1 running\]/);
    });
  });

  test('H hides a Done ticket task, keeping its spec task and the rest under it', async () => {
    const { app } = await started(specTree());
    await press(app, 'H');

    await eventually(() => {
      const rows = lines(app).filter((line) => /^[›\s]+\S\s+T\d/.test(line));
      expect(rows.map((row) => /T\d/.exec(row)![0])).toEqual(['T6', 'T1', 'T3', 'T5', 'T2']);
    });
  });

  test('the spec task’s detail lists its tickets, each with where it stands', async () => {
    const { app } = await started(specTree());
    widen(app, 140);
    // T1 is the second row: T6, T1.
    await press(app, '\x1b[B', '\r');

    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('TICKETS OF ACME/WIDGETS#10');
      expect(frame).toMatch(/acme\/widgets#11 A login form T2 In review/);
      expect(frame).toMatch(/acme\/widgets#12 Remember me waiting on acme\/widgets#11/);
      expect(frame).toMatch(/acme\/widgets#13 SSO held back/);
      expect(frame).toMatch(/acme\/widgets#14 The sign-in route skipped/);
      expect(frame).toMatch(/acme\/widgets#15 Sign out T3 Running/);
      expect(frame).toMatch(/acme\/widgets#16 Lock out merged \(T4\)/);
      expect(frame).toMatch(/acme\/widgets#17 Audit log launching/);
    });
  });

  test('a spec task’s detail says why the factory couldn’t read or launch its tickets', async () => {
    const state = specTree();
    state.tasks.T1!.ticketSet!.problem = 'The factory couldn’t read T1’s tickets from GitHub: Bad gateway.';
    const { app } = await started(state);
    await press(app, '\x1b[B', '\r');

    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('The factory couldn’t read T1’s tickets from GitHub: Bad gateway.'));
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
            recovery: null,
            deniedHosts: null, skipped: null,
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

    await eventually(() => expect(app.lastFrame()).toMatch(/repo missing\s+acme\/widgets\s+The clone of acme\/widgets is no longer at/));
  });

  test('the Factory recovered report shows in Needs you under that name, and 1 on its sheet dismisses it', async () => {
    const connection = new FakeConnection();
    const report = {
      kind: 'attention' as const,
      taskId: null,
      repo: null,
      requestId: 'A3',
      attention: 'recovery-report' as const,
      holdsRun: false,
      reason: 'The factory restarted after it stopped uncleanly. Requeued T1 (R1).',
      question: null,
      permission: null,
      deniedHosts: null, skipped: null,
      recovery: { requeued: [{ taskId: 'T1', runId: 'R1' }], parked: [], failed: [] },
    };
    const { app } = await started(factoryState([task('T1', 'Implement the store', 'running', 'Running')], [report]), { connection });

    // Wide enough for its reason on its row.
    widen(app, 140);
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('› recovered Factory recovered The factory restarted after it stopped uncleanly. Requeued T1 (R1).'));
    await press(app, '\r');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('RECOVERED The factory restarted after it stopped uncleanly. Requeued T1 (R1). [1] Dismiss'));
    await press(app, '1');

    await eventually(() => expect(connection.sent).toContainEqual({ type: 'dismiss', requestId: 'A3' }));
  });
});

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const HOME = '\x1b[H';
const END = '\x1b[F';
const DELETE = '\x1b[3~';
const CTRL_LEFT = '\x1b[1;5D';

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
    interruption: null,
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
    usage: {},
    deniedHosts: [] as string[], waitingForWindow: null,
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

  test('the conversation view takes the terminal’s full height, its keys on the bottom line', async () => {
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } });
    resize(app, 40);
    await press(app, '\r', '\r');
    await eventually(() => {
      const frame = lines(app);
      expect(frame).toHaveLength(40);
      expect(frame.at(-1)).toMatch(/ctrl\+b back/);
    });
  });

  test('N opens the launch card on the repository holding the working directory, and enter launches the prompt into its conversation', async () => {
    const connection = inWidgets();
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/LAUNCH A TASK[\s\S]*Repository\s+acme\/widgets/));
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
    await eventually(() => expect(app.lastFrame()).toMatch(/◇ T1 Grill me about the login flow\.\n[^\n]*In conversation/));
  });

  test('while the daemon names the launch, the card shows a turning spinner, and a second enter launches nothing more', async () => {
    const connection = inWidgets();
    const answer = connection.holdReplies('launchTask');
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/LAUNCH A TASK/));
    await type(app, 'Grill me about the login flow.');
    app.stdin.write('\r');
    await settle();

    await spinsWhileLaunching(app, connection);

    answer({ ok: false, reason: 'The daemon is stopping.' });
    await eventually(() => expect(app.lastFrame()).toContain('The daemon is stopping.'));
    expect(app.lastFrame()).not.toContain('Naming the task…');
  });

  test('esc while the daemon names the launch backs out, and the task launched meanwhile opens no conversation', async () => {
    const connection = inWidgets();
    const answer = connection.holdReplies('launchTask');
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });
    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/LAUNCH A TASK/));
    await type(app, 'Grill me about the login flow.');
    app.stdin.write('\r');
    await eventually(() => expect(app.lastFrame()).toContain('Naming the task…'));

    app.stdin.write('\x1b');
    await eventually(() => expect(app.lastFrame()).not.toMatch(/LAUNCH A TASK/));
    answer({ ok: true, value: { taskId: 'T1' } });
    connection.servePatch([
      { op: 'set', path: ['tasks', 'T1'], value: conversing },
      { op: 'set', path: ['runs', 'R1'], value: run },
    ]);
    await settle();

    expect(connection.conversed).toEqual([]);
    expect(app.lastFrame()).not.toMatch(/ctrl\+b back/);
  });

  test('in the launch card’s prompt, ←→, ctrl+←→, home and end move the cursor, and typing and delete happen at it', async () => {
    const connection = inWidgets();
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/LAUNCH A TASK[\s\S]*Repository\s+acme\/widgets/));
    await type(app, 'Grill me the login flow');
    await press(app, CTRL_LEFT, CTRL_LEFT, CTRL_LEFT);
    await type(app, 'about ');
    await eventually(() => expect(app.lastFrame()).toContain('Grill me about ▏the login flow'));
    await press(app, END, '.', HOME, DELETE, 'g', RIGHT, LEFT, LEFT, RIGHT);
    await eventually(() => expect(app.lastFrame()).toContain('g▏rill me about the login flow.'));
    app.stdin.write('\r');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', prompt: 'grill me about the login flow.' }));
  });

  test('on quick launch, ↑↓ pick another repository while ←→ move the cursor in the prompt', async () => {
    const connection = inWidgets();
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('n');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/QUICK LAUNCH[\s\S]*Repository\s+‹ acme\/widgets ›[\s\S]*↑↓ repository/));
    await type(app, 'Spke the cache');
    await press(app, ...Array('ke the cache'.length).fill(LEFT), 'i', DOWN);
    await eventually(() => expect(app.lastFrame()).toMatch(/Repository\s+‹ acme\/gadgets ›[\s\S]*› Spi▏ke the cache/));
    app.stdin.write('\r');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/gadgets', preset: 'quick', prompt: 'Spike the cache', quick: true }));
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
    await eventually(() => expect(app.lastFrame()).not.toContain('LAUNCH A TASK'));
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
    const app = render(<App connection={connection} cwd="/clones/widgets/src" openUrl={(url) => opened.push(url)} prefs={memoryPrefs()} />);
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
    expect(app.lastFrame()).toContain('LAUNCH A TASK');
    // Once the operator has installed it, the fresh check lifts the block.
    connection.servePatch([{ op: 'set', path: ['repositories', 'acme/widgets'], value: { ...uninstalled, app: { installed: true, checkedAt: 2 } } }]);
    await eventually(() => expect(app.lastFrame()).not.toContain('works unattended'));
    connection.servePatch([{ op: 'set', path: ['repositories', 'acme/widgets'], value: uninstalled }]);

    // A preset with no AFK stage launches as usual.
    await press(app, UP, UP, LEFT);
    await eventually(() => expect(app.lastFrame()).toMatch(/Preset\s+‹ setup \(built-in\) ›/));
    expect(app.lastFrame()).not.toContain('works unattended');
  });

  test('the prompt takes several lines: ctrl+j breaks a line, a list continues, and ↑↓ move between lines before fields', async () => {
    const connection = inWidgets();
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/ctrl\+j new line · ctrl\+e editor/));
    await type(app, 'Steps:');
    await press(app, '\n');
    await type(app, '- one');
    await press(app, '\n');
    await type(app, 'two');
    await press(app, '\n', '\n');
    await type(app, 'Done.');
    // The lines line up under the first, in the value column.
    await eventually(() => {
      const frame = app.lastFrame()!.split('\n');
      const first = frame.findIndex((line) => /Prompt\s+Steps:/.test(line));
      const column = frame[first]!.indexOf('Steps:');
      expect(frame.slice(first, first + 4).map((line) => line.slice(column).replace(/\s*│$/, ''))).toEqual(['Steps:', '- one', '- two', `Done.${GLYPH.caret}`]);
    });
    // ↑ goes up the prompt's lines, at the same column, and on from its first to the field above.
    await press(app, UP, UP, UP);
    await eventually(() => expect(app.lastFrame()).toMatch(new RegExp(`Steps${GLYPH.caret}:`)));
    await press(app, UP);
    await eventually(() => expect(app.lastFrame()).not.toContain(GLYPH.caret));
    await press(app, DOWN);
    app.stdin.write('\r');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Steps:\n- one\n- two\nDone.' }));
  });

  test('ctrl+e has the operator edit the prompt in their own editor, and the card takes what they saved', async () => {
    const connection = inWidgets();
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const edited: string[] = [];
    const editText = async (text: string): Promise<Edited> => {
      edited.push(text);
      return { ok: true, text: `${text}\n\n- with a list` };
    };
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection, editText });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/LAUNCH A TASK/));
    await type(app, 'Fix it');
    await press(app, '\x05');
    await eventually(() => expect(app.lastFrame()).toMatch(new RegExp(`- with a list${GLYPH.caret}`)));
    expect(edited).toEqual(['Fix it']);
    await type(app, '!');
    app.stdin.write('\r');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Fix it\n\n- with a list!' }));
  });

  test('an editor that fails leaves the prompt as it was, and the card says why', async () => {
    const connection = inWidgets();
    const editText = async (): Promise<Edited> => ({ ok: false, reason: 'vi exited with code 1: the prompt is unchanged.' });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection, editText });

    app.stdin.write('N');
    await settle();
    await type(app, 'Fix it');
    await press(app, '\x05');
    await eventually(() => {
      expect(app.lastFrame()).toContain('vi exited with code 1');
      expect(app.lastFrame()).toMatch(new RegExp(`Fix it${GLYPH.caret}`));
    });
  });

  test('a paste keeps its line breaks, and one in it never launches', async () => {
    const connection = inWidgets();
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/LAUNCH A TASK/));
    await press(app, '\x1b[200~First.\r\n\r- one\r\x1b[201~');
    await eventually(() => expect(app.lastFrame()).toMatch(/- one\s*│\n│\s+▏/));
    expect(connection.sent.filter((command) => command.type === 'launchTask')).toEqual([]);
    app.stdin.write('\r');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', prompt: 'First.\n\n- one\n' }));
  });

  test('a long prompt shows at most eight rows, wrapped ones counted, around the caret', async () => {
    const connection = inWidgets();
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/LAUNCH A TASK/));
    await press(app, `\x1b[200~${'word '.repeat(400)}end\x1b[201~`);
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/… \d+ more lines above/);
      expect(frame).toContain(`end${GLYPH.caret}`);
      const rows = frame.split('\n');
      const first = rows.findIndex((row) => row.includes('more lines above'));
      const last = rows.findIndex((row) => row.includes(`end${GLYPH.caret}`));
      expect(last - first).toBe(8);
    });
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

  test('a start stage that takes either input launches on issue refs or a prompt, and not on neither', async () => {
    const connection = inWidgets();
    connection.replyTo('listPresets', {
      ok: true,
      value: {
        defaultPreset: 'implement',
        warning: null,
        presets: [
          {
            name: 'implement',
            source: 'built-in',
            description: null,
            startStages: [{ id: 'implement', mode: 'AFK', model: 'sonnet', needs: ['issues', 'prompt'], anyOf: true }],
            appStages: ['implement'],
          },
        ],
      },
    });
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories }, { cwd: '/clones/widgets/src', connection });

    app.stdin.write('N');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/Issues/));
    app.stdin.write('\r');
    await settle();
    expect(connection.sent.filter((command) => command.type === 'launchTask')).toEqual([]);
    await type(app, 'Fix the login bug');
    app.stdin.write('\r');
    await settle();

    await eventually(() =>
      expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', stage: 'implement', prompt: 'Fix the login bug' }),
    );
  });

  test('an AFK start stage shows the handoff fields, and the card sends the autonomy level, max turns and priority the operator set', async () => {
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
      expect(frame).toMatch(/Autonomy\s+L1 \(on this machine\)/);
      expect(frame).toMatch(/Model tier\s+stage default \(sonnet\)/);
      expect(frame).toMatch(/Max turns\s+stage default \(300\)/);
      expect(frame).toMatch(/Priority\s+normal/);
    });
    await press(app, DOWN, DOWN);
    await type(app, '#12');
    await press(app, DOWN, DOWN, RIGHT);
    await eventually(() => expect(app.lastFrame()).toMatch(/Autonomy\s+‹ L2 \(in its own container\) ›/));
    await press(app, DOWN, DOWN);
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
        autonomy: 'L2',
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
    await press(app, '\r', '\r');
    await settle();
    await eventually(() => expect(connection.conversed).toEqual(['R1']));

    connection.serveConversation(
      'R1',
      { type: 'message', id: 'E1', from: 'operator', text: 'Grill me about the login flow.' },
      { type: 'toolUse', id: 'E2', tool: 'Read', summary: 'src/auth/sso.ts' },
      { type: 'message', id: 'E3', from: 'agent', text: 'Which identity provider times out?' },
    );
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+Grill me about the login flow\.[^\n]*\n[\s\S]*Read\s+src\/auth\/sso\.ts[^\n]*\n[\s\S]*◆\s+Which identity provider times out\?/));

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
    await press(app, '\r', '\r');
    await settle();
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    connection.serveConversation('R1', { type: 'message', id: 'E1', from: 'agent', text: 'Reading the ticket.' });
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/◆\s+Reading the ticket\./));

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
    await press(app, '\r', '\r');
    await settle();
    expect(app.lastFrame()).not.toContain('waiting on you');

    connection.servePatch([{ op: 'set', path: ['runs', 'R1'], value: { ...run, queued: ['Also check Safari.'] } }]);
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/·\s+queued\s+Also check Safari\./));
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

  test('a message taller than the screen reads whole: pgup scrolls back to its first lines, pgdn down to the latest again', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } }, { connection });
    Object.defineProperty(app.stdout, 'rows', { value: 20, configurable: true });
    await press(app, '\r', '\r');
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    const longMessage = Array.from({ length: 40 }, (_, i) => `Line ${i}.`).join('\n');
    connection.serveConversation('R1', { type: 'message', id: 'E1', from: 'agent', text: longMessage });
    // The pane, inside its section's border, shows Line 31 to Line 39, then
    // the agent working mid-turn.
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame.split('\n')).toHaveLength(20);
      expect(frame).toMatch(/\bLine 31\.[\s\S]*Line 39\.[\s\S]*agent working…/);
      expect(frame).not.toContain('Line 30.');
      expect(frame).toContain('pgup/pgdn scroll');
      expect(frame).not.toContain('newer below');
    });

    // A page back keeps the top row in view, to read on from.
    await press(app, PAGE_UP);
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/\bLine 22\.[\s\S]*Line 31\./);
      expect(frame).not.toContain('Line 21.');
      expect(frame).not.toContain('Line 32.');
      expect(frame).toContain('pgup/pgdn scroll (newer below)');
    });

    await press(app, PAGE_UP, PAGE_UP, PAGE_UP, PAGE_UP);
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame.split('\n')).toHaveLength(20);
      expect(frame).toMatch(/◆\s+Line 0\./);
      expect(frame).not.toContain('Line 39.');
    });

    // Scrolled back, what streams in doesn't pull the view away.
    connection.serveConversation('R1', { type: 'message', id: 'E2', from: 'agent', text: 'One more thing.' });
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/◆\s+Line 0\./));
    expect(app.lastFrame()).not.toContain('One more thing.');

    // Down at the latest, it follows them again.
    await press(app, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN);
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('One more thing.');
      expect(frame).not.toMatch(/◆\s+Line 0\./);
    });
    connection.serveConversation('R1', { type: 'message', id: 'E3', from: 'agent', text: 'And another.' });
    await eventually(() => expect(app.lastFrame()).toContain('And another.'));
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
    await press(app, '\r', '\r');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/IdP[\s\S]*Which identity provider times out\?[\s\S]*\[1\]\s+Okta\s+The workforce SSO[\s\S]*\[2\]\s+Auth0\s+The customer login/));

    app.stdin.write('1');
    await settle();
    // The card moves on to its next question, saying how the last was answered.
    await eventually(() => expect(app.lastFrame()).toMatch(/✓ Which identity provider times out\? → Okta[\s\S]*Which browsers fail\?/));
    app.stdin.write('1');
    app.stdin.write('3');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/\[1\]\s+\[x\] Safari[\s\S]*\[2\]\s+\[ \] Firefox[\s\S]*\[3\]\s+\[x\] Chrome/));
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
    // The card closes, and the conversation says what the operator answered.
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).not.toContain('[1] [x] Safari');
      // Wrapped beside the rail.
      expect(frame).toMatch(/✓ Answered Which identity provider times out\? →[\s\S]*Okta · Which browsers fail\? → Safari, Chrome/);
    });
  });

  test('typing on a question card answers it in the operator’s own words', async () => {
    const connection = new FakeConnection();
    const asking = { ...run, question: { id: 'toolu_01', questions: [idp] } };
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: asking } }, { connection });
    await press(app, '\r', '\r');
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
    await press(app, '\r', '\r');
    await settle();

    app.stdin.write('2');
    await settle();

    await eventually(() => expect(connection.sent.at(-1)).toMatchObject({ type: 'answerQuestion', answers: { 'Which identity provider times out?': 'Auth0' } }));
    await eventually(() => expect(app.lastFrame()).toContain('That question is no longer open.'));
    await eventually(() => expect(app.lastFrame()).toMatch(/\[1\]\s+Okta\s+The workforce SSO/));
  });

  test('the conversation view shows the session id, to resume in the operator’s own terminal', async () => {
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } });
    await press(app, '\r', '\r');
    await settle();

    await eventually(() => expect(app.lastFrame()).toContain('claude --resume 5f0c2a8e-3b1d-4c6e-9a7f-2d8b4e1c0a93'));
  });

  test('the conversation opens under ◇ its task, then what it is (mode, model, state); it shows no context share', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => {
      const lines = app.lastFrame()!.split('\n');
      expect(lines[0]).toMatch(/^◇ T1 Grill me about the login flow\./);
      expect(lines[1]).toMatch(/^HITL · claude-sonnet-5-5 · In conversation · factory\/T1-grill-me/);
      expect(lines[2]).toMatch(/^claude --resume /);
      expect(app.lastFrame()).not.toMatch(/ctx|\d+%\s+context/i);
    });
  });

  test('a conversation with no events yet shows a turning “Starting the agent…” spinner, gone at the first event', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } }, { connection });
    await press(app, '\r', '\r');
    await turns(app, 'Starting the agent…');
    expect(app.lastFrame()).not.toContain('agent working…');

    connection.serveConversation('R1', { type: 'message', id: 'E1', from: 'agent', text: 'Which identity provider?' });
    await eventually(() => expect(app.lastFrame()).toContain('Which identity provider?'));
    expect(app.lastFrame()).not.toContain('Starting the agent…');
  });

  test('mid-turn, a turning “agent working…” spinner shows below the last event, not in the header, and is gone once it is the operator’s turn', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    connection.serveConversation('R1', { type: 'message', id: 'E1', from: 'agent', text: 'Reading the login flow.' });
    await turns(app, 'agent working…');
    const frame = app.lastFrame()!;
    expect(frame.indexOf('agent working…')).toBeGreaterThan(frame.indexOf('Reading the login flow.'));
    expect(frame.split('\n')[1]).not.toContain('agent working');

    connection.servePatch([{ op: 'set', path: ['runs', 'R1'], value: { ...run, turn: 'operator' } }]);
    await eventually(() => expect(app.lastFrame()).not.toContain('agent working'));
  });

  const failing = task('T2', 'Implement the store', 'waiting', 'Needs you');
  const failure = {
    kind: 'attention' as const,
    recovery: null,
    deniedHosts: null, skipped: null,
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
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+your turn\s+T1\s+Grill me about the login flow\./));
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
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+failure\s+T2\s+Implement the store/));
    connection.servePatch([
      { op: 'set', path: ['tasks', 'T1'], value: readyForYou },
      { op: 'set', path: ['attentionQueue'], value: [ready, failure] },
    ]);
    await settle();

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('2 Needs you (2)');
      expect(frame).toMatch(/›\s+your turn\s+T1\s+Grill me about the login flow\.\s+Ready for you/);
      expect(frame).toMatch(/^ \s+failure\s+T2\s+Implement the store/m);
    });
  });

  test('enter on a task Ready for you with no live run reopens its conversation', async () => {
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
    await eventually(() => {
      expect(app.lastFrame()).toMatch(/›\s+your turn\s+T3\s+Settle the glossary/);
      expect(app.lastFrame()).toContain('enter opens the conversation');
    });
    app.stdin.write('\r');

    await eventually(() => expect(connection.sent).toEqual([{ type: 'open', taskId: 'T3' }]));
    await eventually(() => expect(app.lastFrame()).toContain('ctrl+b back'));
  });

  test('ctrl+b leaves the conversation for the task’s detail it was opened from, and reopening it replays the conversation afresh', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([conversing]), runs: { R1: run } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    connection.serveConversation('R1', { type: 'message', id: 'E1', from: 'agent', text: 'Which identity provider times out?' });
    await settle();

    app.stdin.write('\x02');
    await settle();
    await eventually(() => expect(connection.left).toEqual(['R1']));
    await eventually(() => expect(app.lastFrame()).toContain('Tasks › T1 Grill me about the login flow.'));
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
    await press(app, '\r', '\r');
    await eventually(() => {
      expect(app.lastFrame()).toContain('ARTIFACTS');
      expect(app.lastFrame()).toMatch(/uncommitted\s+GLOSSARY\.md/);
    });
    // The events and each of the rail's sections in borders of their own.
    for (const heading of ['CONVERSATION', 'USAGE', 'ARTIFACTS']) expect(app.lastFrame()).toMatch(new RegExp(`╭─ ${heading} ─+╮`));
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
    await press(app, '\r', '\r');
    await settle();
    await eventually(() => expect(app.lastFrame()).toContain('ctrl+n advance'));
    expect(app.lastFrame()).not.toContain('proposes');

    connection.servePatch([{ op: 'set', path: ['runs', 'R1'], value: { ...run, proposal: { kind: 'advance', reason: 'The login flow is settled.' } } }]);
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('The agent proposes advancing: The login flow is settled. ctrl+n review'));

    app.stdin.write(CTRL_N);
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('ADVANCE T1 FROM GRILL');
      expect(frame).toMatch(/› glossary opus optional ← advances here spec opus optional tickets opus then implement \(AFK\): the handoff starts it/);
    });
  });

  test('enter on the advance sheet advances the task, and the conversation carries on with the next stage’s run', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([onLean]), runs: { R1: run } }, { connection });
    await press(app, '\r', '\r');
    await settle();
    app.stdin.write(CTRL_N);
    await eventually(() => expect(app.lastFrame()).toContain('ADVANCE T1 FROM GRILL'));

    app.stdin.write('\r');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'advanceStage', taskId: 'T1' }));
    await eventually(() => expect(app.lastFrame()).not.toContain('ADVANCE T1'));

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
    await press(app, '\r', '\r');
    await settle();
    app.stdin.write(CTRL_N);
    await settle();

    await press(app, ' ', DOWN, ' ', DOWN, ' ');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/glossary opus optional · skipped spec opus optional · skipped › tickets opus ← advances here/));
    app.stdin.write('\r');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'advanceStage', taskId: 'T1', skip: ['glossary', 'spec'] }));
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('tickets can’t start'));
    expect(app.lastFrame()).toContain('ADVANCE T1 FROM GRILL');

    // Taking a skip back makes that stage the one advanced to again.
    await press(app, UP, ' ');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/glossary opus optional · skipped › spec opus optional ← advances here tickets opus/));

    app.stdin.write('\x1b');
    await eventually(() => expect(app.lastFrame()).not.toContain('ADVANCE T1'));
    expect(connection.sent.filter((command) => command.type === 'advanceStage')).toHaveLength(1);
    expect(connection.sent.filter((command) => command.type === 'interrupt')).toEqual([]);
  });

  test('the advance sheet says when the next stage is the handoff’s, or the last stage is ending; a task without a preset has none', async () => {
    const connection = new FakeConnection();
    const atTickets = { ...onLean, stage: 'tickets' };
    const { app } = await started({ ...factoryState([atTickets]), runs: { R1: run } }, { connection });
    await press(app, '\r', '\r');
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
    ticketSets: null,
  };

  test('the agent’s proposal to hand off shows as a banner, and ctrl+h or /handoff opens the handoff sheet, even over an open card', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([onLean]), runs: { R1: run } }, { connection });
    await press(app, '\r', '\r');
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

  test('while the daemon opens the handoff, “Opening the handoff…” turns, a second ctrl+h sends nothing more, and the spinner gives way to the sheet or the refusal', async () => {
    const connection = new FakeConnection();
    const answer = connection.holdReplies('openHandoff');
    const { app } = await started({ ...factoryState([onLean]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => expect(app.lastFrame()).toContain('/handoff hand off'));

    app.stdin.write(CTRL_H);
    await turns(app, 'Opening the handoff…');
    await press(app, CTRL_H);
    await type(app, '/handoff');
    app.stdin.write('\r');
    await settle();
    expect(connection.sent.filter((command) => command.type === 'openHandoff')).toHaveLength(1);

    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: { ...onLean, handoff: { ...sheet, brief } } }]);
    answer({ ok: true });
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('HAND OFF T1 TO IMPLEMENT (AFK)'));
    expect(app.lastFrame()).not.toContain('Opening the handoff…');

    const refusing = new FakeConnection();
    const refuse = refusing.holdReplies('openHandoff');
    const { app: refused } = await started({ ...factoryState([onLean]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection: refusing });
    await press(refused, '\r', '\r');
    await eventually(() => expect(refused.lastFrame()).toContain('/handoff hand off'));
    refused.stdin.write(CTRL_H);
    await turns(refused, 'Opening the handoff…');
    refuse({ ok: false, reason: 'T1 has no handoff to open.' });
    await eventually(() => expect(refused.lastFrame()).toContain('T1 has no handoff to open.'));
    expect(refused.lastFrame()).not.toContain('Opening the handoff…');
  });

  test('confirming the handoff sheet shows “Handing off…” turning until the daemon replies, and a second enter sends nothing more', async () => {
    const connection = new FakeConnection();
    const answer = connection.holdReplies('handoff');
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: { ...sheet, brief } }]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('HAND OFF T1 TO IMPLEMENT (AFK)'));

    app.stdin.write('\r');
    await turns(app, 'Handing off…');
    await press(app, '\r');
    await settle();
    expect(connection.sent.filter((command) => command.type === 'handoff')).toHaveLength(1);

    answer({ ok: false, reason: 'The handoff is blocked.' });
    await eventually(() => expect(app.lastFrame()).toContain('The handoff is blocked.'));
    expect(app.lastFrame()).not.toContain('Handing off…');

    // Confirmed again and taken: the spinner and the sheet both go.
    const handOff = connection.holdReplies('handoff');
    app.stdin.write('\r');
    await turns(app, 'Handing off…');
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: onLean }]);
    handOff({ ok: true });
    await eventually(() => expect(app.lastFrame()).not.toContain('HAND OFF T1'));
    expect(app.lastFrame()).not.toContain('Handing off…');
    expect(connection.sent.filter((command) => command.type === 'handoff')).toHaveLength(2);
  });

  test('while the sheet asks again for a brief the agent didn’t write, “Opening the handoff…” turns, and esc still backs out', async () => {
    const connection = new FakeConnection();
    connection.holdReplies('openHandoff');
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: sheet }]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => expect(app.lastFrame()).toContain('enter asks again'));

    app.stdin.write('\r');
    await turns(app, 'Opening the handoff…');
    app.stdin.write('\x1b');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'closeHandoff', taskId: 'T1' }));
  });

  test('while the daemon advances the task, “Advancing…” turns on the sheet, a second enter or esc does nothing, and the sheet closes on the reply', async () => {
    const connection = new FakeConnection();
    const answer = connection.holdReplies('advanceStage');
    const { app } = await started({ ...factoryState([onLean]), runs: { R1: run } }, { connection });
    await press(app, '\r', '\r');
    await settle();
    app.stdin.write(CTRL_N);
    await eventually(() => expect(app.lastFrame()).toContain('ADVANCE T1 FROM GRILL'));

    app.stdin.write('\r');
    await turns(app, 'Advancing…');
    await press(app, '\r', '\x1b');
    await settle();
    expect(connection.sent.filter((command) => command.type === 'advanceStage')).toHaveLength(1);
    expect(app.lastFrame()).toContain('ADVANCE T1 FROM GRILL');

    answer({ ok: true });
    await eventually(() => expect(app.lastFrame()).not.toContain('ADVANCE T1'));
    expect(app.lastFrame()).not.toContain('Advancing…');
  });

  test('while the daemon reopens a parked conversation, “Reopening the conversation…” turns, a second enter sends nothing more, and the message follows the reply', async () => {
    const connection = new FakeConnection();
    const answer = connection.holdReplies('open');
    const { app } = await started({ ...factoryState([onLean]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    connection.servePatch([
      { op: 'set', path: ['runs', 'R1'], value: { ...run, turn: 'operator' as const, status: 'ended' as const, outcome: 'parked' as const } },
      { op: 'set', path: ['tasks', 'T1'], value: { ...onLean, state: 'queued' as const, label: 'Ready for you', liveRunId: null } },
    ]);
    await eventually(() => expect(app.lastFrame()).toContain('enter reopens and sends'));

    await type(app, 'Still there?');
    app.stdin.write('\r');
    await turns(app, 'Reopening the conversation…');
    await press(app, '\r');
    await settle();
    expect(connection.sent).toEqual([{ type: 'open', taskId: 'T1' }]);

    answer({ ok: true });
    await eventually(() =>
      expect(connection.sent).toEqual([
        { type: 'open', taskId: 'T1' },
        { type: 'sendMessage', taskId: 'T1', text: 'Still there?' },
      ]),
    );
    expect(app.lastFrame()).not.toContain('Reopening the conversation…');
  });

  test('over the handoff sheet, pgup still pages back through the conversation', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: { ...sheet, brief } }]), runs: { R1: run } }, { connection });
    Object.defineProperty(app.stdout, 'rows', { value: 40, configurable: true });
    await press(app, '\r', '\r');
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    connection.serveConversation('R1', { type: 'message', id: 'E1', from: 'agent', text: Array.from({ length: 60 }, (_, i) => `Line ${i}.`).join('\n') });
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('HAND OFF T1 TO IMPLEMENT (AFK)');
      expect(frame).toContain('Line 59.');
      expect(frame).not.toContain('◆ Line 0.');
    });

    await press(app, ...Array.from({ length: 30 }, () => PAGE_UP));
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('HAND OFF T1 TO IMPLEMENT (AFK)');
      expect(frame).toContain('◆ Line 0.');
      expect(frame).not.toContain('Line 59.');
    });
  });

  test('a brief taller than the screen scrolls inside the sheet, its fields, hint and the footer staying in view', async () => {
    const connection = new FakeConnection();
    const long = { ...brief, decided: Array.from({ length: 40 }, (_, i) => `Decision ${i}.`) };
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: { ...sheet, brief: long } }]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection });
    Object.defineProperty(app.stdout, 'rows', { value: 24, configurable: true });
    await press(app, '\r', '\r');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      const flat = unwrapped(frame);
      expect(flat).toContain('HAND OFF T1 TO IMPLEMENT (AFK)');
      expect(flat).toContain('Goal Failed webhook deliveries are retried.');
      expect(flat).not.toContain('Decision 39.');
      expect(flat).toContain('Max turns 300');
      expect(flat).toContain('esc keep talking');
      expect(flat).toContain('ctrl+b back');
    });

    // The selected line stays in view as ↓ walks the brief.
    await press(app, ...Array.from({ length: 40 }, () => DOWN));
    await eventually(() => {
      const flat = unwrapped(app.lastFrame()!);
      expect(flat).toContain('› - Decision 39.');
      expect(flat).not.toContain('Goal Failed webhook');
      expect(flat).toContain('Max turns 300');
      expect(flat).toContain('ctrl+b back');
    });
  });

  test('the sheet waits on the agent’s brief, then the operator edits it, changes continue-as, autonomy level and max turns, and enter hands off', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: sheet }]), runs: { R1: run } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('HAND OFF T1 TO IMPLEMENT (AFK)');
      expect(frame).toContain('The agent is writing the brief…');
      expect(frame).toContain('the conversation fills 23% of the context window');
      expect(frame).toContain('The handoff commit takes GLOSSARY.md.');
    });
    // Enter waits for the brief: the operator confirms what they have read.
    app.stdin.write('\r');
    await settle();
    expect(connection.sent).toEqual([]);

    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: { ...onLean, handoff: { ...sheet, brief } } }]);
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/› Goal Failed webhook deliveries are retried\.▏ Decided - Retry 5xx and timeouts only\. \+ Done when \+/));

    await type(app, ' with backoff');
    // Down past the decided item, onto the line that adds one.
    await press(app, DOWN, DOWN);
    await type(app, 'Never 4xx.');
    // Down to the fields, past done when's, out of scope's and links' lines.
    await press(app, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, RIGHT, DOWN, RIGHT, DOWN, DOWN, '\x7f', '\x7f', '\x7f', '5', '0');
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('- Never 4xx.');
      expect(frame).toContain('Continue as ‹ fresh ›');
      expect(frame).toContain('Autonomy ‹ L2 (in its own container) ›');
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
          autonomy: 'L2',
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

    // T2, the newest, is on top.
    await press(app, CTRL_H);
    await settle();
    expect(connection.sent).toEqual([]);
    await press(app, DOWN, CTRL_H);

    await eventually(() => expect(connection.sent).toEqual([{ type: 'openHandoff', taskId: 'T1' }]));
    await eventually(() => expect(app.lastFrame()).toContain('claude --resume'));
  });

  test('c on a parked HITL task reopens its conversation, and a refused reopen stays on the list', async () => {
    const parked = { ...onLean, state: 'queued' as const, label: 'Ready for you', liveRunId: null };
    const ended = { ...run, status: 'ended' as const, outcome: 'parked' as const };
    const refusing = new FakeConnection();
    refusing.replyTo('open', { ok: false, reason: 'T1 isn’t ready for a conversation (it is Done).' });
    const { app: refused } = await started({ ...factoryState([parked]), runs: { R1: ended } }, { connection: refusing });
    await press(refused, 'c');
    await eventually(() => expect(refused.lastFrame()).toContain('T1 isn’t ready for a conversation (it is Done).'));
    expect(refused.lastFrame()).not.toContain('claude --resume');

    const { app, connection } = await started({ ...factoryState([parked]), runs: { R1: ended } });
    await press(app, 'c');
    await eventually(() => expect(connection.sent).toEqual([{ type: 'open', taskId: 'T1' }]));
    await eventually(() => expect(app.lastFrame()).toContain('claude --resume'));
  });

  test('a conversation parked while it is open reopens on the next message, which is then sent', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([onLean]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    connection.servePatch([
      { op: 'set', path: ['runs', 'R1'], value: { ...run, turn: 'operator' as const, status: 'ended' as const, outcome: 'parked' as const } },
      { op: 'set', path: ['tasks', 'T1'], value: { ...onLean, state: 'queued' as const, label: 'Ready for you', liveRunId: null } },
    ]);
    await eventually(() => expect(app.lastFrame()).toContain('enter reopens and sends'));

    await type(app, 'Still there?');
    app.stdin.write('\r');

    await eventually(() =>
      expect(connection.sent).toEqual([
        { type: 'open', taskId: 'T1' },
        { type: 'sendMessage', taskId: 'T1', text: 'Still there?' },
      ]),
    );
  });

  // A ticket of a spec candidate on the handoff sheet.
  const ticket = (n: number, more: { open?: boolean; openBlockers?: string[]; labels?: string[] } = {}) => ({
    ref: `acme/widgets#${n}`,
    title: `Ticket ${n}`,
    open: more.open ?? true,
    labels: more.labels ?? ['ready-for-agent'],
    openBlockers: more.openBlockers ?? [],
  });
  const ticketSets = {
    candidates: [
      { spec: 'acme/widgets#11', title: 'Webhooks', tickets: [ticket(12)] },
      { spec: 'acme/widgets#132', title: 'Webhook retries', tickets: [ticket(133), ticket(134, { openBlockers: ['acme/widgets#133'] }), ticket(135), ticket(136, { open: false }), ticket(137, { labels: [] })] },
    ],
    selected: 'acme/widgets#132',
    withoutTickets: [{ ref: 'acme/widgets#140', title: 'Retries (Part of #132)' }],
    problem: null,
  };

  test('the sheet shows each spec candidate with its tickets and how many are ready now, the factory’s pick selected, and issues with 0 tickets', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: { ...sheet, brief, ticketSets } }]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection });
    await press(app, '\r', '\r');

    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('[ ] Spec #11 Webhooks → 1 ticket, 1 ready now');
      expect(frame).toContain('[x] Spec #132 Webhook retries → 5 tickets, 2 ready now');
      expect(frame).toContain('#140 Retries (Part of #132) → 0 tickets: none are its sub-issues');
    });
    app.stdin.write('\r');
    await eventually(() => expect(connection.sent).toMatchObject([{ type: 'handoff', taskId: 'T1', specs: ['acme/widgets#132'] }]));
  });

  test('the sheet lists each spec candidate’s tickets held back by their label, and counts a ready-for-human one as ready now', async () => {
    const tickets = [ticket(133), ticket(134, { labels: ['ready-for-human'] }), ticket(137, { labels: [] }), ticket(138, { labels: ['needs-triage'], openBlockers: ['acme/widgets#133'] }), ticket(139, { labels: [], open: false })];
    const sets = { ...ticketSets, candidates: [{ spec: 'acme/widgets#132', title: 'Webhook retries', tickets }], withoutTickets: [] };
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: { ...sheet, brief, ticketSets: sets } }]), runs: { R1: { ...run, turn: 'operator' as const } } });
    await press(app, '\r', '\r');

    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('[x] Spec #132 Webhook retries → 5 tickets, 2 ready now');
      expect(frame).toContain('Held back by their label: #137 (no label), #138 (needs-triage)');
    });
  });

  test('on the sheet, space toggles a spec candidate, selecting it alone; with none selected the handoff is one run on the brief', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: { ...sheet, brief, ticketSets } }]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('[x] Spec #132'));

    // Down past the brief's goal and lists, onto the first candidate.
    await press(app, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ' ');
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('› Ticket set [x] Spec #11 Webhooks');
      expect(frame).toContain('[ ] Spec #132 Webhook retries');
    });
    await press(app, ' ');
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('› Ticket set [ ] Spec #11 Webhooks');
      expect(frame).toContain('No ticket set: the handoff is one run on the brief.');
    });

    app.stdin.write('\r');
    await eventually(() => expect(connection.sent).toMatchObject([{ type: 'handoff', taskId: 'T1', specs: [] }]));
  });

  test('the sheet starts on the factory’s pick, and picks afresh when the factory reads other candidates', async () => {
    const connection = new FakeConnection();
    const onSpec11 = { ...ticketSets, selected: 'acme/widgets#11' };
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: { ...sheet, brief, ticketSets: onSpec11 } }]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('[x] Spec #11 Webhooks'));

    const reread = { ...ticketSets, candidates: [{ spec: 'acme/widgets#150', title: 'Signing', tickets: [ticket(151)] }], selected: 'acme/widgets#150' };
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: { ...onLean, handoff: { ...sheet, brief, ticketSets: reread } } }]);
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('[x] Spec #150 Signing'));
    app.stdin.write('\r');
    await eventually(() => expect(connection.sent).toMatchObject([{ type: 'handoff', specs: ['acme/widgets#150'] }]));
  });

  test('a handoff with no spec candidate says it is one run on the brief, and why the factory couldn’t read them', async () => {
    const problem = 'The factory couldn’t read T1’s issues’ sub-issues from GitHub: GitHub refused the call (HTTP 404: Not Found).';
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: { ...sheet, brief, ticketSets: { candidates: [], selected: null, withoutTickets: [], problem } } }]), runs: { R1: run } });
    await press(app, '\r', '\r');

    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('No ticket set: the handoff is one run on the brief.');
      expect(frame).toContain(problem);
    });
  });

  test('a blocked handoff shows what blocks it, and esc backs out of the sheet to keep talking', async () => {
    const connection = new FakeConnection();
    connection.replyTo('handoff', { ok: false, reason: 'The handoff is blocked. spike is checked out.' });
    const blocked = { ...sheet, brief, readiness: { blockers: ['factory/T1 isn’t checked out in T1’s worktree: spike is.'], toCommit: [] } };
    const { app } = await started({ ...factoryState([{ ...onLean, handoff: blocked }]), runs: { R1: { ...run, turn: 'operator' as const } } }, { connection });
    await press(app, '\r', '\r');
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
    await eventually(() => expect(app.lastFrame()).not.toContain('HAND OFF T1'));
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
    recovery: null,
    deniedHosts: null, skipped: null,
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
    recovery: null,
    deniedHosts: null, skipped: null,
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
      // Each row: its kind, its task and what it waits for.
      expect(frame).toMatch(/› failure T2 Implement the store The agent hit max turns\. question T1 Fix the login bug Which identity provider times out\?/);
      // A rule says which item the sheet under it answers.
      expect(frame).toMatch(/── 1\/2 ── T2 Implement the store ─+/);
      expect(frame).toContain('FAILURE The agent hit max turns. [1] Retry [2] Take over [3] Cancel a answer');
    });

    await press(app, 'a', '1');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2' }));
    connection.servePatch([{ op: 'set', path: ['attentionQueue'], value: [asked] }]);

    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toMatch(/› question T1 Fix the login bug Which identity provider times out\?/);
      expect(frame).toMatch(/── 1\/1 ── T1 Fix the login bug/);
      expect(frame).toMatch(/IdP Which identity provider times out\? \[1\] Okta The workforce SSO \[2\] Auth0 The customer login/);
      expect(frame).toContain('digits answer · esc back');
    });
    await press(app, '2');
    await eventually(() =>
      expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', answers: { 'Which identity provider times out?': 'Auth0' } }),
    );
    // Answering, the digits never switched screens.
    expect(app.lastFrame()).toContain('Fix the login bug');
  });

  test('once an answer goes through, Needs you says what was answered and with which options, as the request leaves', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([asking, failing], [failure, asked]), { connection });
    await press(app, '2', 'a', '1');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2' }));
    connection.servePatch([{ op: 'set', path: ['attentionQueue'], value: [asked] }]);
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('✓ Answered T2 Implement the store: Retry');
      expect(frame).toMatch(/── 1\/1 ── T1 Fix the login bug/);
    });

    await press(app, '2');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', answers: { 'Which identity provider times out?': 'Auth0' } }));
    connection.servePatch([{ op: 'set', path: ['attentionQueue'], value: [] }]);
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('Nothing needs you.');
      expect(frame).toContain('✓ Answered T1 Fix the login bug: Which identity provider times out? → Auth0');
      expect(frame).not.toContain('T2 Implement the store: Retry');
    });

    // The condensed view's Needs you says it too.
    await press(app, ESC, 'v');
    await eventually(() => expect(app.lastFrame()).toContain('DETAIL'));
    expect(app.lastFrame()).toContain('✓ Answered T1 Fix the login bug');

    // Left, however it is left, Needs you no longer says it.
    await press(app, ':', ...'task 1', ENTER, 'v');
    await eventually(() => expect(app.lastFrame()).toContain('Tasks › T1'));
    await press(app, '2');
    await eventually(() => expect(app.lastFrame()).toContain('Nothing needs you.'));
    expect(app.lastFrame()).not.toContain('Answered');
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

  test('a failed ticket task’s run can be retried, taken over or cancelled: there is no ticket to skip', async () => {
    const ticketTask = { ...failing, kind: 'ticket' as const, ticket: 'acme/widgets#11' };
    const { app } = await started(factoryState([ticketTask], [failure]));
    await press(app, '2');

    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('FAILURE The agent hit max turns. [1] Retry [2] Take over [3] Cancel a answer'));
  });

  test('a failed L2 run lists the hosts it was denied: a digit allows them for its task and retries it', async () => {
    const connection = new FakeConnection();
    const denied = {
      ...failure,
      reason: 'pip install failed. Its container’s egress proxy denied pypi.org and files.pythonhosted.org.',
      deniedHosts: ['pypi.org', 'files.pythonhosted.org'],
    };
    const { app } = await started(factoryState([{ ...failing, autonomy: 'L2' as const }], [denied]), { connection });
    await press(app, '2');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain(
        '[1] Retry [2] Allow both hosts for this task and retry [3] Allow pypi.org for this task and retry [4] Allow files.pythonhosted.org for this task and retry [5] Take over [6] Cancel a answer',
      ),
    );

    await press(app, 'a', '4');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2', allowHosts: ['files.pythonhosted.org'] }));

    const again = new FakeConnection();
    const { app: other } = await started(factoryState([{ ...failing, autonomy: 'L2' as const }], [denied]), { connection: again });
    await press(other, '2', 'a', '2');
    await eventually(() => expect(again.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2', allowHosts: ['pypi.org', 'files.pythonhosted.org'] }));
  });

  test('a task frozen on the retired Ralph loop can only be cancelled, to relaunch it', async () => {
    const connection = new FakeConnection();
    const retired = {
      ...failing,
      stage: 'implement',
      preset: { ...wayfinder, stages: [{ id: 'implement', kind: 'loop' as const, skill: 'implement', mode: 'AFK' as const, exit: 'tickets-closed' }] },
    };
    const reason = 'This preset’s loop was retired: implement works tickets through the Ralph loop (exit tickets-closed), which the factory no longer runs. Cancel T2, or relaunch it.';
    const blocked = { ...failure, attention: 'stage-blocked' as const, reason };
    const { app } = await started(factoryState([retired], [blocked]), { connection });
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('or relaunch it. [1] Cancel a answer'));

    await press(app, 'a', '1');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'cancel', taskId: 'T2' }));
  });

  test('a GitHub write the factory couldn’t make is tried again once the operator answers', async () => {
    const connection = new FakeConnection();
    const cancelled = task('T2', 'Implement the store', 'cancelled', 'Cancelled');
    const unreopened = { ...failure, attention: 'github-write' as const, reason: 'The factory couldn’t reopen acme/widgets#11 on GitHub as its App.' };
    const { app } = await started(factoryState([cancelled], [unreopened]), { connection });
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('as its App. [1] Try again a answer'));

    await press(app, 'a', '1');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2' }));
  });

  test('a PR closed without merging offers Cancel task or Reopen PR', async () => {
    const connection = new FakeConnection();
    const inReview = task('T2', 'Implement the store', 'in-review', 'In review');
    const closed = { ...failure, attention: 'pr-closed-unmerged' as const, reason: 'PR #101 of T2 was closed without merging. Cancel the task, or reopen the PR.' };
    const { app } = await started(factoryState([inReview], [closed]), { connection });
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('reopen the PR. [1] Cancel task [2] Reopen PR a answer'));

    await press(app, 'a', '2');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'reopenPr', taskId: 'T2' }));
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
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('[1] Keep branch [2] Discard work'));
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
    await eventually(() => expect(app.lastFrame()).toMatch(/T2\s+Implement the store\s+AFK L1\s+Running/));
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
        'PERMISSION Bash: npm publish [1] Allow once [2] Allow for this task: Bash(npm publish *) [3] Allow always: Bash(npm publish *) [4] Deny with a note a answer',
      ),
    );

    await press(app, 'a', '1');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2', permission: { allow: 'once' } }));
    connection.servePatch([{ op: 'set', path: ['attentionQueue'], value: [{ ...permission, requestId: 'A4' }] }]);
    await settle();
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('npm publish: Bash(npm publish *)▏ enter allows for this task · esc back'));
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
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('[2] Allow for this task: Bash(npm install *), Bash(sed -i *)'));

    await press(app, 'a', '2');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain(
        "› npm install zod: Bash(npm install *)▏ sed -i 's/a/b/' src/a.ts: Bash(sed -i *) ↑↓ field · enter allows for this task · esc back",
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
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('npm publish: Bash(npm publish *)▏ enter allows always · esc back'));

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
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('Note for the agent: ▏ enter denies · esc back'));

    await press(app, ESC);
    await eventually(() => expect(app.lastFrame()).toContain('[4] Deny with a note'));
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

  test('a root in review offers Request changes, Mark done, Cancel and Push & open draft PR, and Request changes sends the typed review comments', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([reviewing], [review]), { connection });
    await press(app, '2');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain(
        'REVIEW In review [1] Request changes [2] Mark done [3] Cancel [4] Push & open draft PR a answer',
      ),
    );

    await press(app, 'a', '1');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('Review comments: ▏ enter requests changes · esc back'));
    app.stdin.write('Put it in the header');
    await eventually(() => expect(app.lastFrame()).toContain('Review comments: Put it in the header'));
    await press(app, ENTER);
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'requestChanges', taskId: 'T3', comments: 'Put it in the header' }));
  });

  test('the option the operator picks on the answer sheet is lit: its digit in the review colour, the others in the accent', async () => {
    const level = chalk.level;
    chalk.level = 3;
    onTestFinished(() => void (chalk.level = level));
    // A digit in brackets, in the review colour (terracotta) or the accent.
    const lit = (digit: number) => new RegExp(`\\x1b\\[38;2;210;140;121m(?:\\x1b\\[1m)?\\[${digit}\\]`);
    const plain = (digit: number) => new RegExp(`\\x1b\\[38;2;159;206;126m(?:\\x1b\\[1m)?\\[${digit}\\]`);
    const { app } = await started(factoryState([reviewing], [review]));
    await press(app, '2');
    await eventually(() => expect(app.lastFrame()).toMatch(plain(1)));
    expect(app.lastFrame()).not.toMatch(lit(1));

    // Request changes, picked, stays lit while its comments are typed.
    await press(app, 'a', '1');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(lit(1));
      expect(frame).toMatch(plain(2));
    });
    await press(app, 'x');
    expect(app.lastFrame()).toMatch(lit(1));

    // Set aside, it is no longer picked.
    await press(app, ESC);
    await eventually(() => expect(app.lastFrame()).toMatch(plain(1)));
    expect(app.lastFrame()).not.toMatch(lit(1));
  });

  test('on a question’s multi-select the options toggled on are lit too', async () => {
    const level = chalk.level;
    chalk.level = 3;
    onTestFinished(() => void (chalk.level = level));
    const lit = (digit: number) => new RegExp(`\\x1b\\[38;2;210;140;121m(?:\\x1b\\[1m)?\\[${digit}\\]`);
    const multi = { ...question, questions: [{ ...question.questions[0]!, question: 'Which providers time out?', multiSelect: true }] };
    const { app } = await started(factoryState([asking], [{ ...asked, question: multi }]));
    await press(app, '2', 'a', '2');
    await eventually(() => expect(app.lastFrame()).toMatch(lit(2)));
    expect(app.lastFrame()).not.toMatch(lit(1));
  });

  test('Push & open draft PR publishes the L1 root; once it has its PR the choice pushes to it, and none shows while it is under way', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([reviewing], [review]), { connection });
    await press(app, '2', 'a', '4');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'pushAndOpenPr', taskId: 'T3' }));

    const opened = { ...reviewing, pr: { number: 101, url: 'https://github.com/acme/widgets/pull/101', draft: true } };
    const withPr = await started(factoryState([opened], [review]));
    await press(withPr.app, '2');
    await eventually(() => expect(unwrapped(withPr.app.lastFrame()!)).toContain('[3] Cancel [4] Push to draft PR #101 a answer'));

    // Where GitHub offers no draft PRs, the factory opened a regular one.
    const regular = await started(factoryState([{ ...opened, pr: { ...opened.pr, draft: false } }], [review]));
    await press(regular.app, '2');
    await eventually(() => expect(unwrapped(regular.app.lastFrame()!)).toContain('[3] Cancel [4] Push to PR #101 a answer'));

    const underWay = await started(factoryState([{ ...reviewing, publishing: { step: 'push' as const, problem: null } }], [review]));
    await press(underWay.app, '2');
    await eventually(() => expect(unwrapped(underWay.app.lastFrame()!)).toContain('[3] Cancel a answer'));

    // Pushed since its last run started, its PR has all its work.
    const pushed = await started(factoryState([{ ...opened, pushed: true }], [review]));
    await press(pushed.app, '2');
    await eventually(() => expect(unwrapped(pushed.app.lastFrame()!)).toContain('[3] Cancel a answer'));
  });

  test('a root still in review once its choice went through takes the digits again: a later push, or Mark done', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([reviewing], [review]), { connection });
    await press(app, '2', 'a', '4');
    await eventually(() => expect(connection.sent).toEqual([{ type: 'pushAndOpenPr', taskId: 'T3' }]));

    const opened = { ...reviewing, pr: { number: 101, url: 'https://github.com/acme/widgets/pull/101', draft: true } };
    connection.serveSnapshot(factoryState([opened], [review]));
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('[4] Push to draft PR #101'));
    await press(app, '4');
    await eventually(() => expect(connection.sent).toHaveLength(2));
    await press(app, '2');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'markDone', taskId: 'T3' }));
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
        'factory/T3-add-a-logout-button has 2 commits that exist nowhere else. [1] Keep branch [2] Discard work enter Keep branch · esc back',
      ),
    );

    connection.replyTo('cancel', { ok: true });
    await press(app, '2');
    await eventually(() => expect(connection.sent.at(-1)).toEqual(discard));
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).not.toContain('[2] Discard work');
      expect(frame).toContain('✓ Answered T3 Add a logout button: Cancel, Discard work');
    });
  });

  test('a missing repository takes no digits, and its sheet says how to fix it', async () => {
    const connection = new FakeConnection();
    const missing = { ...failure, taskId: null, requestId: 'A3', attention: 'repo-missing' as const, reason: 'The clone of acme/widgets is no longer at /clones/widgets.' };
    const { app } = await started(factoryState([], [missing]), { connection });
    await press(app, '2', 'a', '1');

    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('REPO MISSING The clone of acme/widgets is no longer at /clones/widgets. Put the clone back'));
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
    interruption: null,
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
    usage: {},
    deniedHosts: [] as string[], waitingForWindow: null,
  };
  const permission = {
    kind: 'attention' as const,
    recovery: null,
    deniedHosts: null, skipped: null,
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
    await press(app, ENTER, ENTER);
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    return app;
  }

  test('an AFK task that needs the operator shows its request in its conversation, and a digit answers it there', async () => {
    const connection = new FakeConnection();
    const app = await opened(permission, connection);
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('PERMISSION Bash: gh issue view 12 [1] Allow once [2] Allow for this task: Bash(gh issue view 12) [3] Allow always: Bash(gh issue view 12) [4] Deny with a note');
      expect(frame).toContain('digits answer · c take over · ctrl+b back');
      expect(frame).not.toContain('esc back');
    });

    // A request stored before rules were proposed per part proposes the call's own.
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('gh issue view 12: Bash(gh issue view 12)▏ enter allows for this task · esc back'));
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
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('Note for the agent: ▏ enter denies · esc back'));
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
    await press(app, ENTER, ENTER);
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    connection.serveConversation(
      'R1',
      ...Array.from({ length: 30 }, (_, i) => ({ type: 'message' as const, id: `E${i}`, from: 'agent' as const, text: `Step ${i}.` })),
    );
    await settle();
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain(`PERMISSION Bash: ${command} [1] Allow once [2] Allow for this task: Bash(for f *), Bash(do sed *), Bash(done *) [3]`);
      expect(frame).toContain('digits answer · c take over · ctrl+b back');
      expect(frame).toContain('Step 29.');
      expect(frame).not.toContain('Step 0.');
    });
  });

  test('a heredoc’s exact rule takes one line on the sheet, so a full screen keeps every choice in view', async () => {
    const script = ["cat > /tmp/edit.py <<'EOF'", ...Array.from({ length: 41 }, (_, i) => `print(${i})`), 'EOF'].join('\n');
    const flat = script.replace(/\s+/g, ' ').slice(0, 200);
    const heredoc = {
      ...permission,
      reason: `Bash: ${flat}…`,
      permission: { id: 'toolu_1', tool: 'Bash', summary: `${flat}…`, rule: `Bash(${script})`, proposed: [{ part: `${flat}…`, rule: `Bash(${script})` }] },
    };
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([waiting], [heredoc]), runs: { R1: suspended } }, { connection });
    Object.defineProperty(app.stdout, 'rows', { value: 30 });
    await press(app, ENTER, ENTER);
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain("[2] Allow for this task: Bash(cat > /tmp/edit.py <<'EOF' ↵ print(0) ↵");
      expect(frame).toContain('print(40) ↵ EOF) [3] Allow always');
      expect(frame).not.toContain('print(20)');
      expect(frame).toContain('[4] Deny with a note');
      expect(frame).toContain('digits answer · c take over · ctrl+b back');
    });

    // Its field shows the rule as the label does, and allows it whole.
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('print(40) ↵ EOF)▏ enter allows for this task · esc back'));
    await press(app, ENTER);
    await eventually(() =>
      expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', permission: { allow: 'task', rules: [`Bash(${script})`] } }),
    );
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
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/API Which endpoint\? \[1\] v1 The old one \[2\] v2 The new one/));

    await press(app, '2');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', answers: { 'Which endpoint?': 'v2' } }));
    // Taken, the answer shows in the conversation.
    await eventually(() => expect(app.lastFrame()).toContain('✓ Answered Which endpoint? → v2'));
  });

  test('a HITL run’s permission card shows in its conversation, answered as a request is, and chat waits until it is', async () => {
    const connection = new FakeConnection();
    const hitl: TaskView = { ...task('T1', 'Grill me about the login flow.', 'running', 'In conversation', 'HITL'), liveRunId: 'R1' };
    const card = {
      id: 'toolu_3',
      tool: 'Bash',
      summary: 'npm test',
      rule: 'Bash(npm test)',
      proposed: [{ part: 'npm test', rule: 'Bash(npm test *)' }],
    };
    const asking = { ...suspended, mode: 'HITL' as const, autonomy: null, status: 'active' as const, permission: card };
    const { app } = await started({ ...factoryState([hitl]), runs: { R1: asking } }, { connection });
    await press(app, ENTER, ENTER);
    await eventually(() => expect(connection.conversed).toEqual(['R1']));
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('PERMISSION Bash: npm test [1] Allow once [2] Allow for this task: Bash(npm test *) [3] Allow always: Bash(npm test *) [4] Deny with a note');
      expect(frame).toContain('The agent is waiting on you.');
      expect(frame).toContain('digits answer · ctrl+b back');
      expect(frame).not.toContain('›');
    });

    await press(app, '1');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', permission: { allow: 'once' } }));
    connection.servePatch([{ op: 'set', path: ['runs', 'R1'], value: { ...asking, permission: null } }]);
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      // The card is gone, and the conversation says how it was answered.
      expect(frame).not.toContain('[1] Allow once');
      expect(frame).toContain('✓ Answered Allow once');
      expect(frame).toContain('enter queue · esc interrupt');
    });
  });

  test('an answer given on Needs you shows in the conversation after the call it answers, and still does once the conversation is left and reopened', async () => {
    const connection = new FakeConnection();
    const question = {
      id: 'toolu_02',
      questions: [{ question: 'Which endpoint?', header: 'API', options: [{ label: 'v1', description: 'The old one' }, { label: 'v2', description: 'The new one' }], multiSelect: false }],
    };
    const asked = { ...permission, attention: 'question' as const, reason: 'Which endpoint?', question, permission: null };
    const { app } = await started({ ...factoryState([waiting], [asked]), runs: { R1: suspended } }, { connection });
    await press(app, '2', 'a', '2');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', answers: { 'Which endpoint?': 'v2' } }));
    connection.servePatch([{ op: 'set', path: ['attentionQueue'], value: [] }]);

    // The run's events: the answer goes after the call it answers, not after the latest.
    const events: ConversationEvent[] = [
      { type: 'message', id: 'E1', from: 'agent', text: 'Reading the issue.' },
      { type: 'toolUse', id: 'E2', tool: 'AskUserQuestion', summary: 'Which endpoint?', toolUseId: 'toolu_02' },
      { type: 'message', id: 'E3', from: 'agent', text: 'Going with v2.' },
    ];
    for (const time of [1, 2]) {
      // Esc gives the digits back to the screens.
      await press(app, ESC, '1', ENTER, ENTER);
      await eventually(() => expect(connection.conversed).toHaveLength(time));
      connection.serveConversation('R1', ...events);
      await eventually(() => {
        const frame = app.lastFrame()!;
        const at = (text: string) => frame.indexOf(text);
        expect(at('AskUserQuestion')).toBeGreaterThan(at('Reading the issue.'));
        expect(at('✓ Answered Which endpoint? → v2')).toBeGreaterThan(at('AskUserQuestion'));
        expect(at('Going with v2.')).toBeGreaterThan(at('✓ Answered Which endpoint? → v2'));
      });
      await press(app, '\x02');
    }
  });

  test('an answer given in the conversation stays in it once the task’s next run starts, before that run’s events', async () => {
    const connection = new FakeConnection();
    const failure = { ...permission, attention: 'failure' as const, holdsRun: false, reason: 'The agent hit max turns.', permission: null };
    const app = await opened(failure, connection);
    connection.serveConversation('R1', { type: 'message', id: 'E1', from: 'agent', text: 'Out of turns.' });
    await press(app, '1');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1' }));
    await eventually(() => expect(app.lastFrame()).toContain('✓ Answered Retry'));

    // Retried, the task's next run takes the conversation over.
    const retried = { ...suspended, id: 'R2', status: 'active' as const, startedAt: 2 };
    connection.servePatch([
      { op: 'set', path: ['attentionQueue'], value: [] },
      { op: 'set', path: ['runs', 'R2'], value: retried },
      { op: 'set', path: ['tasks', 'T1', 'liveRunId'], value: 'R2' },
    ]);
    await eventually(() => expect(connection.conversed).toEqual(['R1', 'R2']));
    connection.serveConversation('R2', { type: 'message', id: 'E9', from: 'agent', text: 'Trying again.' });
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame.indexOf('Trying again.')).toBeGreaterThan(frame.indexOf('✓ Answered Retry'));
      expect(frame).toContain('✓ Answered Retry');
    });
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
    interruption: null,
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
    usage: {},
    deniedHosts: [] as string[], waitingForWindow: null,
  };
  const permission = {
    kind: 'attention' as const,
    recovery: null,
    deniedHosts: null, skipped: null,
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
    await press(app, ENTER, ENTER);
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
    await press(app, ENTER, ENTER);
    await eventually(() => expect(app.lastFrame()).toContain('digits answer · c take over · ctrl+b back'));

    await press(app, 'c');

    await eventually(() => expect(connection.sent).toEqual([{ type: 'takeOver', taskId: 'T2' }]));
  });

  test('while the daemon takes the task over from its conversation, “Taking over…” turns, and a second c sends nothing more', async () => {
    const connection = new FakeConnection();
    const answer = connection.holdReplies('takeOver');
    const waiting = { ...task('T2', 'Publish the package', 'waiting', 'Needs you'), liveRunId: 'R1' };
    const { app } = await started({ ...factoryState([waiting], [permission]), runs: { R1: { ...afkRun, taskId: 'T2', status: 'suspended' as const } } }, { connection });
    await press(app, ENTER, ENTER);
    await eventually(() => expect(app.lastFrame()).toContain('c take over'));

    app.stdin.write('c');
    await turns(app, 'Taking over…');
    await press(app, 'c');
    await settle();
    expect(connection.sent).toEqual([{ type: 'takeOver', taskId: 'T2' }]);

    answer({ ok: false, reason: 'T2 is no longer live.' });
    await eventually(() => expect(app.lastFrame()).toContain('T2 is no longer live.'));
    expect(app.lastFrame()).not.toContain('Taking over…');
  });
});

describe('the conversation of an AFK task that is no longer live', () => {
  test('offers no takeover: an In review task’s view says only that it takes no chat', async () => {
    const connection = new FakeConnection();
    const reviewed = task('T1', 'Implement acme/widgets#12', 'in-review', 'In review');
    const ended = {
      id: 'R1', taskId: 'T1', mode: 'AFK' as const, autonomy: 'L1' as const, status: 'ended' as const, outcome: 'completed' as const, interruption: null,
      turn: 'agent' as const, queued: [] as string[], question: null, permission: null, stage: 'implement', ticket: null, proposal: null,
      tier: 'sonnet' as const, model: 'claude-sonnet-5-5', maxTurns: 300, cli: null, skillSet: null, startedAt: 1, endedAt: 2, usage: {}, deniedHosts: [] as string[], waitingForWindow: null,
    };
    const { app } = await started({ ...factoryState([reviewed]), runs: { R1: ended } }, { connection });
    await press(app, '\r', '\r');
    await eventually(() => expect(app.lastFrame()).toContain('AFK runs take no chat · ctrl+b back'));

    await press(app, 'c');

    expect(connection.sent).toEqual([]);
  });
});

describe('usage', () => {
  const SONNET = 'claude-sonnet-5-5';
  const HAIKU = 'claude-haiku-5-5';
  const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) => ({ input, output, cacheRead, cacheWrite, cost });
  function metered(id: string, taskId: string, stage: string | null, ticket: string | null, used: RunView['usage']): RunView {
    return {
      id, taskId, mode: 'AFK', autonomy: 'L1', status: 'ended', outcome: 'completed', interruption: null, turn: 'agent', queued: [], question: null, permission: null, stage, ticket,
      proposal: null, tier: 'sonnet', model: SONNET, maxTurns: 300, cli: null, skillSet: null, startedAt: 1, endedAt: 2, usage: used, deniedHosts: [], waitingForWindow: null,
    };
  }
  const implementing = { ...task('T1', 'Implement the login flow', 'running', 'Running'), groups: ['login'] };
  const child = { ...task('T2', 'Write the logout test', 'done', 'Done'), parent: 'T1', groups: ['login'] };
  const grilling = { ...task('T3', 'Grill me about the docs', 'queued', 'Ready for you', 'HITL'), groups: ['docs'] };
  const runs = {
    R1: metered('R1', 'T1', 'implement', 'acme/widgets#11', { [SONNET]: usage(1_000, 100, 2_000_000, 50_000, 1.25) }),
    R2: metered('R2', 'T1', 'implement', 'acme/widgets#12', { [SONNET]: usage(2_000, 200, 0, 0, 0.5) }),
    R3: metered('R3', 'T2', null, null, { [HAIKU]: usage(300, 30, 0, 0, 0.125) }),
    R4: metered('R4', 'T3', 'grill', null, {}),
  };
  const metering = () => ({ ...factoryState([implementing, child, grilling]), runs });

  test('4 opens the Usage tab: each model’s tokens by kind and API-equivalent cost, then each task tree, group, stage and ticket', async () => {
    const { app } = await started(metering());
    await eventually(() => expect(app.lastFrame()).toContain('4 Usage'));

    await press(app, '4');

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/claude-sonnet-5-5\s+3\.0k\s+300\s+2\.0M\s+50\.0k\s+\$1\.75/);
      expect(frame).toMatch(/claude-haiku-5-5\s+300\s+30\s+0\s+0\s+\$0\.13/);
      expect(frame).toMatch(/Total\s+3\.3k\s+330\s+2\.0M\s+50\.0k\s+\$1\.88/);
      // T1's tree takes in its child T2: trees are listed by their root.
      expect(frame).toMatch(/T1\s+Implement the login flow\s+2\.1M tokens\s+\$1\.88/);
      expect(frame).not.toMatch(/T2\s+Write the logout test/);
      expect(frame).toMatch(/login\s+2\.1M tokens\s+\$1\.88/);
      expect(frame).toMatch(/implement\s+2\.1M tokens\s+\$1\.75/);
      expect(frame).toMatch(/acme\/widgets#11\s+2\.1M tokens\s+\$1\.25/);
      expect(frame).toMatch(/acme\/widgets#12\s+2\.2k tokens\s+\$0\.50/);
    });
    // A task, group or stage that spent nothing has no row.
    expect(app.lastFrame()).not.toMatch(/docs\s+/);
    expect(app.lastFrame()).not.toMatch(/grill\s+/);
  });

  test('the Usage tab opens on gauges of the usage windows, the slots and the last hours’ tokens, and bars each model’s and group’s tokens', async () => {
    const resetsAt = Date.UTC(2026, 9, 29, 14, 30);
    const { app } = await started({
      ...metering(),
      slots: { active: 1, cap: 2 },
      usage: { window: { spent: 0.5, resetsAt }, weekly: { spent: 0.25, resetsAt: Date.UTC(2026, 10, 2, 9) }, tokensPerHour: [0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 400, 800] },
    });

    await press(app, '4');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(new RegExp(`5-hour window\\s+${'█'.repeat(20)}${'░'.repeat(20)} 50% · resets 14:30`));
      expect(frame).toMatch(new RegExp(`Weekly window\\s+${'█'.repeat(10)}${'░'.repeat(30)} 25%`));
      // Only AFK work waits for a slot: T3, a HITL task Ready for you, isn't queued for one.
      expect(frame).toMatch(/Parallel slots\s+●○ 1\/2 running · 0 queued/);
      expect(frame).toMatch(/Tokens \/ hour, 12h\s+▁▁▁▁▁▁▁▁▁▂▅█/);
      // The largest model's and group's bars full, the others scaled to them.
      expect(frame).toMatch(/claude-sonnet-5-5\s+3\.0k\s+300\s+2\.0M\s+50\.0k\s+\$1\.75\s+█{16}\s*│$/m);
      expect(frame).toMatch(/claude-haiku-5-5\s+300\s+30\s+0\s+0\s+\$0\.13\s+░{16}\s*│$/m);
      expect(frame).toMatch(/login\s+2\.1M tokens\s+\$1\.88\s+█{16}\s*│$/m);
      // The gauges, the models and each breakdown in borders of their own.
      for (const heading of ['WINDOWS AND SLOTS', 'MODELS', 'TASK TREES', 'GROUPS', 'STAGES', 'TICKETS']) expect(frame).toMatch(new RegExp(`^╭─ ${heading} ─+╮$`, 'm'));
    });
  });

  describe('the usage strip', () => {
    const resetsAt = Date.UTC(2026, 9, 29, 14, 30);
    const reading = (state: FactoryState): FactoryState => ({
      ...state,
      slots: { active: 1, cap: 2 },
      usage: { window: { spent: 0.42, resetsAt }, weekly: { spent: 0.181, resetsAt: Date.UTC(2026, 10, 2, 9) }, tokensPerHour: [0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 400, 800] },
    });
    // The frame with its lines run together: the strip's parts wrap on a narrow terminal.
    const oneLine = (app: { lastFrame(): string | undefined }) => app.lastFrame()!.replace(/\s*\n\s*/g, ' ');
    const strip = /window ██████░░░░░░░░ 42% ↻ 14:30 │ week █░░░░░ 18% │ slots ●○ 1\/2 │ ▁▁▁▁▁▁▁▁▁▂▅█ 800\/h │ claude-sonnet-5-5 2\.1M · claude-haiku-5-5 330/;

    test('shows the usage window and its reset, the weekly window, slots, a tokens/hour sparkline and tokens by model, on every screen', async () => {
      const { app } = await started(reading(metering()));
      await eventually(() => expect(oneLine(app)).toMatch(strip));

      for (const screen of ['2', '3', '4']) {
        await press(app, screen);
        await eventually(() => expect(oneLine(app)).toMatch(strip));
      }
      // T1's detail, under T3, the newest, and the condensed view.
      await press(app, '1', '\x1b[B', '\r');
      await eventually(() => expect(app.lastFrame()).toContain('task tree'));
      expect(oneLine(app)).toMatch(strip);
      await press(app, '\x1b', 'v');
      await eventually(() => expect(app.lastFrame()).toContain('Condensed'));
      expect(oneLine(app)).toMatch(strip);
    });

    test('shows in a task’s conversation too', async () => {
      const talking = { ...task('T4', 'Grill me about billing', 'running', 'In conversation', 'HITL'), liveRunId: 'R5', worktree: '/worktrees/acme-widgets/T4', sessionId: 'b1' };
      const live = { ...metered('R5', 'T4', 'grill', null, {}), mode: 'HITL' as const, autonomy: null, status: 'active' as const, outcome: null, endedAt: null };
      const state = reading(metering());
      const { app } = await started({ ...state, tasks: { T4: talking }, runs: { ...runs, R5: live } });
      await press(app, '\r', '\r');

      await eventually(() => expect(app.lastFrame()).toContain('Grill me about billing'));
      expect(oneLine(app)).toMatch(/window ██████░░░░░░░░ 42% ↻ 14:30 │ week █░░░░░ 18% │ slots ●○ 1\/2/);
    });

    test('a usage window with no snapshot to trust shows as unknown', async () => {
      const { app } = await started({ ...factoryState([grilling]), usage: { window: null, weekly: null, tokensPerHour: Array(12).fill(0) } });

      await eventually(() => expect(app.lastFrame()).toContain('window unknown │ week unknown │ slots ○○ 0/2 │ ▁▁▁▁▁▁▁▁▁▁▁▁ 0/h'));
    });

    test('a run waiting out a usage limit shows waiting for window on the Runs screen', async () => {
      const waiting = { ...metered('R5', 'T1', 'implement', null, {}), status: 'active' as const, outcome: null, endedAt: null, waitingForWindow: resetsAt };
      const { app } = await started({ ...metering(), runs: { R5: waiting } });
      await press(app, '3');

      await eventually(() => expect(app.lastFrame()).toMatch(/R5\s+T1\s+Implement the login flow\s+AFK\s+implement\s+claude-sonnet-5-5\s+waiting for window/));
    });
  });

  test('the Usage tab of a factory that spent nothing says so', async () => {
    const { app } = await started(factoryState([grilling]));
    await press(app, '4');

    await eventually(() => expect(app.lastFrame()).toContain('No usage yet.'));
  });

  test('a task’s detail shows its usage per model with API-equivalent cost, and its tree’s once it has children', async () => {
    const { app } = await started(metering());
    // T1, under T3, the newest.
    await press(app, '\x1b[B', '\r');

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('Usage');
      expect(frame).toMatch(/claude-sonnet-5-5\s+2\.1M\s+\$1\.75/);
      expect(frame).toMatch(/task tree\s+2\.1M\s+\$1\.88/);
    });
  });
});

const SONNET = 'claude-sonnet-5-5';
function ran(id: string, taskId: string, at: number, fields: Partial<RunView> = {}): RunView {
  return {
    id, taskId, mode: 'AFK', autonomy: 'L1', status: 'ended', outcome: 'completed', interruption: null, turn: 'agent', queued: [], question: null, permission: null, stage: 'implement',
    ticket: null, proposal: null, tier: 'sonnet', model: SONNET, maxTurns: 300, cli: null, skillSet: null, startedAt: at, endedAt: at + 1, usage: {}, deniedHosts: [], waitingForWindow: null, ...fields,
  };
}

describe('the screens view', () => {
  const grilling = task('T1', 'Grill me about the docs', 'queued', 'Ready for you', 'HITL');
  const implementing = { ...task('T2', 'Implement the store', 'running', 'Running'), liveRunId: 'R3', stage: 'implement' };
  const screens = () => factoryState([grilling, implementing]);

  test('the tabs are 1 Tasks, 2 Needs you, 3 Runs and 4 Usage; enter drills into a task’s detail and esc pops back to where it was', async () => {
    const { app } = await started(screens());
    await eventually(() => expect(app.lastFrame()).toMatch(/1 Tasks\s+2 Needs you \(0\)\s+3 Runs\s+4 Usage/));

    // T2, the newest, is on top.
    await press(app, '\r');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('Tasks › T2 Implement the store');
      expect(frame).not.toContain('Grill me about the docs');
    });

    await press(app, '\x1b');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).not.toContain('Tasks ›');
      expect(frame).toMatch(/›\s+\S\s+T2\s+Implement the store/);
    });

    // From a task's detail a number key goes to that screen, leaving the detail behind.
    await press(app, '\r', '3');
    await eventually(() => expect(app.lastFrame()).not.toContain('Tasks ›'));
    await press(app, '1');
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+\S\s+T2\s+Implement the store/));
    expect(app.lastFrame()).not.toContain('Tasks ›');
  });

  test('a task’s detail: its title, what it is on one line, its open request, then its runs, usage, artifacts and live output', async () => {
    const child = {
      ...implementing,
      parent: 'T1',
      depth: 1,
      child: { awaited: true, base: 'abc123', report: null },
      branch: 'factory/T2-implement-the-store',
      groups: ['store', 'billing'],
      tier: 'opus' as const,
    };
    const failed: FactoryState['attentionQueue'][number] = {
      kind: 'attention', recovery: null, deniedHosts: null, skipped: null, taskId: 'T2', repo: 'acme/widgets', requestId: 'Q1', attention: 'failure', holdsRun: false, reason: 'The agent hit max turns.', question: null, permission: null,
    };
    const runs = { R3: ran('R3', 'T2', 5, { status: 'active', outcome: null, endedAt: null }) };
    const { app } = await started({ ...factoryState([grilling, child], [failed]), runs });
    // Wide enough for the whole of the line that says what it is.
    widen(app, 180);

    await press(app, '\x1b[B', '\r');

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/^T2 Implement the store$/m);
      expect(frame).toMatch(/^AFK L1 · claude-sonnet-5-5 · opus · Running · store, billing · parent T1 Grill me about the docs \(awaited\)$/m);
      // Where it is, on a line of its own.
      expect(frame).toMatch(/^implement · factory\/T2-implement-the-store$/m);
      expect(unwrapped(frame)).toContain('FAILURE The agent hit max turns. a answer');
      expect(frame).toMatch(/RUNS[\s\S]*USAGE[\s\S]*ARTIFACTS[\s\S]*● LIVE OUTPUT · T2 · R3/);
      // Each section in a border of its own, its heading on the top edge.
      for (const heading of ['RUNS', 'USAGE', 'ARTIFACTS', '● LIVE OUTPUT · T2 · R3']) expect(frame).toMatch(new RegExp(`^╭─ ${heading} ─+╮$`, 'm'));
      // Theirs and the request sheet's.
      expect(frame.match(/^╰─+╯$/gm)).toHaveLength(5);
    });
  });

  test('a task’s detail lists its runs with mode, stage, model, outcome and usage, then its artifacts', async () => {
    const usage = (input: number, output: number, cost: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost });
    const runs = {
      R1: ran('R1', 'T2', 1, { outcome: 'failed', usage: { [SONNET]: usage(1_000, 100, 0.5) } }),
      R2: ran('R2', 'T2', 3, { stage: 'review', model: 'claude-opus-5-5', outcome: 'interrupted', usage: { 'claude-opus-5-5': usage(20_000, 2_000, 1.25) } }),
      R3: ran('R3', 'T2', 5, { status: 'active', outcome: null, endedAt: null }),
      R4: ran('R4', 'T1', 2, { mode: 'HITL', stage: 'grill' }),
    };
    const artifacts = {
      F1: { id: 'F1', taskId: 'T2', runId: 'R1', kind: 'file' as const, path: 'src/store/store.ts', committed: true },
      F2: { id: 'F2', taskId: 'T1', runId: 'R4', kind: 'file' as const, path: 'docs/glossary.md', committed: false },
      I1: { id: 'I1', taskId: 'T2', runId: 'R2', kind: 'issue' as const, url: 'https://github.com/acme/widgets/issues/14' },
    };
    const { app } = await started({ ...screens(), runs, artifacts });

    // T2, the newest, is on top.
    await press(app, '\r');

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/^AFK L1 · claude-sonnet-5-5 · sonnet · Running\n\s*implement$/m);
      expect(frame).toMatch(/R1\s+AFK\s+implement\s+claude-sonnet-5-5\s+failed\s+1\.1k\s+\$0\.50[^\n]*\n[^\n]*R2\s+AFK\s+review\s+claude-opus-5-5\s+interrupted\s+22\.0k\s+\$1\.25[^\n]*\n[^\n]*R3\s+AFK\s+implement\s+claude-sonnet-5-5\s+live\s+0\s+\$0\.00/);
      expect(frame).not.toContain('R4');
      expect(frame).toMatch(/committed\s+src\/store\/store\.ts/);
      expect(frame).toMatch(/issue\s+acme\/widgets#14/);
      expect(frame).not.toContain('docs/glossary.md');
    });
  });

  test('the output pane under the task tree follows the selected task’s run, without opening its conversation', async () => {
    const conversing = { ...grilling, liveRunId: 'R1' };
    const runs = { R1: ran('R1', 'T1', 1, { mode: 'HITL', stage: 'grill', status: 'active', outcome: null, turn: 'operator' }), R3: ran('R3', 'T2', 2, { status: 'active', outcome: null }) };
    const { app, connection } = await started({ ...factoryState([conversing, implementing]), runs });
    // T2, the newest, is on top.
    await eventually(() => expect(connection.followed).toEqual(['R3']));
    connection.serveConversation('R3', { type: 'toolUse', id: 'E2', tool: 'Edit', summary: 'src/store/store.ts' });
    await eventually(() => expect(app.lastFrame()).toMatch(/LIVE OUTPUT · T2 · R3[\s\S]*\n│ {3,}Edit\s+src\/store\/store\.ts/));

    await press(app, '\x1b[B');
    await eventually(() => expect(connection.followed).toEqual(['R3', 'R1']));
    connection.serveConversation('R1', { type: 'message', id: 'E1', from: 'agent', text: 'Which identity provider times out?' });
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/LIVE OUTPUT · T1 · R1[\s\S]*◆\s+Which identity provider times out\?/);
      expect(frame).not.toContain('src/store/store.ts');
    });

    // The detail follows it too.
    await press(app, '\r');
    await eventually(() => expect(connection.followed).toEqual(['R3', 'R1', 'R1']));
    connection.serveConversation('R1', { type: 'message', id: 'E3', from: 'agent', text: 'Which one, Okta or Entra?' });
    await eventually(() => expect(app.lastFrame()).toMatch(/Tasks › T1[\s\S]*LIVE OUTPUT · T1 · R1[\s\S]*◆\s+Which one, Okta or Entra\?/));
    expect(connection.conversed).toEqual([]);
  });

  test('the output pane gives each event one row, so a long message leaves the tabs and the task tree on screen', async () => {
    const runs = { R3: ran('R3', 'T2', 2, { status: 'active', outcome: null }) };
    const { app, connection } = await started({ ...factoryState([task('T1', 'Settle the glossary', 'queued', 'Ready for you', 'HITL'), implementing]), runs });
    // T2, the newest, is on top.
    await eventually(() => expect(connection.followed).toEqual(['R3']));
    const before = app.lastFrame()!.split('\n').length;
    const message = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    connection.serveConversation(
      'R3',
      { type: 'message', id: 'E1', from: 'agent', text: message },
      { type: 'toolUse', id: 'E2', tool: 'Bash', summary: 'npm test\n  --run' },
    );

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('1 Tasks');
      expect(frame).toMatch(/› \S\s+T2\s+Implement the store[\s\S]*T1\s+Settle the glossary/);
      expect(frame).toMatch(/◆\s+Paragraph 0\. Paragraph 1\./);
      expect(frame).toMatch(/\n│ {3,}Bash\s+npm test --run/);
      // The two events replace "No runs yet." with two rows.
      expect(frame.split('\n')).toHaveLength(before + 1);
    });
  });

  test('on a short terminal the Tasks screen fits it: the tree scrolls with the cursor, under the tabs and over its keys and output', async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => task(`T${i + 1}`, `Task number ${i + 1}`, 'queued', 'Ready for you', 'HITL'));
    const { app } = await started(factoryState(tasks));
    resize(app, 14);
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame.split('\n')).toHaveLength(14);
      expect(frame).toContain('1 Tasks');
      // The newest on top.
      expect(frame).toMatch(/› \S\s+T20\s+Task number 20\b/);
      expect(frame).not.toMatch(/T1\s+Task number 1\b/);
      expect(frame).toContain('enter detail');
      expect(frame).toContain('OUTPUT · T20');
    });

    await press(app, ...Array.from({ length: 15 }, () => DOWN));
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame.split('\n')).toHaveLength(14);
      expect(frame).toContain('1 Tasks');
      expect(frame).toMatch(/› \S\s+T5\s+Task number 5\b/);
      expect(frame).not.toContain('Task number 20');
      expect(frame).toContain('enter detail');
      expect(frame).toContain('OUTPUT · T5');
    });

    // Back up, the tree scrolls back with it.
    await press(app, ...Array.from({ length: 15 }, () => UP));
    await eventually(() => expect(app.lastFrame()).toMatch(/1 Tasks[\s\S]*› \S\s+T20\s+Task number 20\b/));
  });

  test('on a short terminal the Runs screen scrolls with its cursor under the tabs', async () => {
    const runs = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`R${i + 1}`, ran(`R${i + 1}`, 'T1', 100 - i)]));
    const { app } = await started({ ...factoryState([grilling]), runs });
    resize(app, 12);
    await press(app, '3', ...Array.from({ length: 15 }, () => DOWN));
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame.split('\n')).toHaveLength(12);
      expect(frame).toContain('3 Runs');
      expect(frame).toMatch(/› R16\s+T1/);
      expect(frame).not.toMatch(/R1\s+T1/);
    });
  });

  test('a task’s detail shows its conversation whole: every message in full, the user’s and the agent’s', async () => {
    const runs = { R3: ran('R3', 'T2', 2, { status: 'active', outcome: null }) };
    const { app, connection } = await started({ ...factoryState([implementing]), runs });
    await press(app, '\r');
    await eventually(() => expect(app.lastFrame()).toContain('Tasks › T2'));
    // Wider than the terminal, so it wraps.
    const wraps = Array.from({ length: 36 }, (_, i) => `word${i}`).join(' ');
    connection.serveConversation(
      'R3',
      { type: 'message', id: 'E1', from: 'operator', text: `Keep the schema private.\nAnd ${wraps} end of mine.` },
      { type: 'message', id: 'E2', from: 'agent', text: `Done.\n\nThe store ${wraps} end of the agent’s.` },
    );

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).not.toContain('…');
      expect(frame).toMatch(/›\s+Keep the schema private\.[^\n]*\n│\s+And word0/);
      expect(unwrapped(frame)).toContain(`And ${wraps} end of mine.`);
      expect(unwrapped(frame)).toContain(`The store ${wraps} end of the agent’s.`);
    });
  });

  test('on a short terminal a task’s detail keeps its latest messages in view, older ones scrolling off over the runs', async () => {
    const runs = { R3: ran('R3', 'T2', 2, { status: 'active', outcome: null }) };
    const { app, connection } = await started({ ...factoryState([implementing]), runs });
    // Rows for the frame around the detail.
    resize(app, 26);
    await press(app, '\r');
    await eventually(() => expect(app.lastFrame()).toContain('Tasks › T2'));
    connection.serveConversation(
      'R3',
      ...Array.from({ length: 30 }, (_, i) => ({ type: 'message' as const, id: `E${i}`, from: 'agent' as const, text: `Step ${i}.\nIts second line.` })),
    );

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame.split('\n')).toHaveLength(26);
      expect(frame).toContain('Tasks › T2');
      expect(frame).toContain('Step 29.');
      expect(frame).not.toContain('Step 0.');
      expect(frame).toContain('esc back');
    });
  });

  test('3 opens the Runs screen: every run, live ones first and then newest first; enter drills into its task and esc comes back to it', async () => {
    const runs = {
      R1: ran('R1', 'T2', 1, { outcome: 'failed' }),
      R2: ran('R2', 'T1', 2, { mode: 'HITL', stage: 'grill', outcome: 'parked' }),
      R3: ran('R3', 'T2', 5, { status: 'active', outcome: null, endedAt: null }),
      R5: ran('R5', 'T1', 3, { mode: 'HITL', stage: 'grill', status: 'suspended', outcome: null, endedAt: null }),
    };
    const { app } = await started({ ...screens(), runs });

    await press(app, '3');
    await eventually(() => {
      // A row naming the columns, over the runs.
      expect(app.lastFrame()).toMatch(/^\s+run\s+task\s+title\s+mode\s+stage\s+model\s+status\s+tokens\n[›\s]+R3/m);
      const rows = app.lastFrame()!.split('\n').filter((line) => /^[›\s]+R\d/.test(line));
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatch(/R3\s+T2\s+Implement the store\s+AFK\s+implement\s+claude-sonnet-5-5\s+live/);
      expect(rows[1]).toMatch(/R5\s+T1\s+Grill me about the docs\s+HITL\s+grill\s+claude-sonnet-5-5\s+suspended/);
      expect(rows[2]).toMatch(/R2\s+T1\s+Grill me about the docs\s+HITL\s+grill\s+claude-sonnet-5-5\s+parked/);
      expect(rows[3]).toMatch(/R1\s+T2\s+Implement the store\s+AFK\s+implement\s+claude-sonnet-5-5\s+failed/);
    });

    await press(app, '\x1b[B', '\r');
    await eventually(() => expect(app.lastFrame()).toContain('Runs › T1 Grill me about the docs'));
    await press(app, '\x1b');
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+R5\s+T1/));
  });

  test('Done and Cancelled tasks show dimmed, a cancelled one struck through, and H hides them, keeping a finished task whose subtree still has work', async () => {
    // The dim role in the 16 colours (gray) right before the title, through any other styles.
    const dimmed = (title: string) => new RegExp(`\\x1b\\[90m(?:\\x1b\\[\\d+m)*${title}`);
    const STRUCK = '\x1b[9m';
    const titles: Record<string, string> = { T1: 'Implement the store', T2: 'Settle the glossary', T5: 'Check the links', T3: 'Write the spec', T4: 'Ship the release' };
    // Styles show in the frame only with colour on, which a test's stdout doesn't detect.
    const level = chalk.level;
    chalk.level = 1;
    onTestFinished(() => void (chalk.level = level));
    const { app } = await started(
      factoryState([
        task('T1', 'Implement the store', 'running', 'Running'),
        task('T2', 'Settle the glossary', 'done', 'Done'),
        { ...task('T5', 'Check the links', 'done', 'Done'), parent: 'T2', depth: 1 },
        task('T3', 'Write the spec', 'cancelled', 'Cancelled'),
        task('T4', 'Ship the release', 'done', 'Done'),
        { ...task('T6', 'Tag the release', 'running', 'Running'), parent: 'T4', depth: 1 },
      ]),
    );
    const row = (id: string) => app.lastFrame()!.split('\n').find((line) => new RegExp(`^[›\\s]+\\S\\s+${id}\\b`).test(line.replace(/\x1b\[\d+m/g, '')));
    // The cursor off the finished tasks, on T1 at the bottom: T4, T6, T3, T2, T5, T1.
    await press(app, ...Array.from({ length: 5 }, () => '\x1b[B'));

    await eventually(() => {
      expect(row('T1')).not.toMatch(dimmed(titles.T1!));
      for (const id of ['T2', 'T5', 'T3', 'T4']) expect(row(id)).toMatch(dimmed(titles[id]!));
      expect(row('T3')).toContain(STRUCK);
      expect(row('T2')).not.toContain(STRUCK);
    });

    await press(app, 'H');
    await eventually(() => {
      for (const id of ['T1', 'T4', 'T6']) expect(row(id)).toBeDefined();
      for (const id of ['T2', 'T5', 'T3']) expect(row(id)).toBeUndefined();
      expect(app.lastFrame()).toContain('3 finished hidden · H shows them');
    });

    await press(app, 'H');
    await eventually(() => expect(row('T3')).toBeDefined());
  });

  test('a task launched meanwhile comes on top without taking the cursor from the task it was on', async () => {
    const { app, connection } = await started(factoryState([task('T1', 'Implement the store', 'running', 'Running')]));
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+\S\s+T1\s+Implement the store/));

    connection.servePatch([{ op: 'set', path: ['tasks', 'T2'], value: task('T2', 'Settle the glossary', 'queued', 'Ready for you', 'HITL') }]);
    await eventually(() => expect(app.lastFrame()).toMatch(/T2\s+Settle the glossary[\s\S]*›\s+\S\s+T1\s+Implement the store/));
    await press(app, 'x');
    await eventually(() => expect(connection.sent).toEqual([{ type: 'cancel', taskId: 'T1' }]));
  });

  test('with a group filter, H counts only the finished tasks it hides, and :task to a hidden one leaves the cursor where it was', async () => {
    const { app } = await started(
      factoryState([
        { ...task('T1', 'Implement the store', 'running', 'Running'), groups: ['store'] },
        { ...task('T2', 'Settle the glossary', 'done', 'Done'), groups: ['store'] },
        task('T3', 'Write the docs', 'running', 'Running'),
        task('T4', 'Bump CI', 'done', 'Done'),
        { ...task('T5', 'Index the store', 'running', 'Running'), groups: ['store'] },
      ]),
    );
    await press(app, ':', ...'group store', '\r', 'H');
    await eventually(() => expect(app.lastFrame()).toContain('1 finished hidden · H shows them'));

    await press(app, ':', ...'task 2', '\r');
    await eventually(() => expect(app.lastFrame()).toContain('Tasks › T2 Settle the glossary'));
    // Back on T5, the top row, not on whatever row T2 has in the whole tree.
    await press(app, '\x1b');
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+\S\s+T5\s+Index the store/));
  });

  test('with every task finished, H leaves a line that says so and how to show them again', async () => {
    const { app } = await started(factoryState([task('T1', 'Implement the store', 'done', 'Done'), task('T2', 'Settle the glossary', 'cancelled', 'Cancelled')]));
    await eventually(() => expect(app.lastFrame()).toContain('Settle the glossary'));

    await press(app, 'H');
    await eventually(() => expect(app.lastFrame()).toContain('Every task is finished. H shows the 2.'));
    expect(app.lastFrame()).not.toContain('Implement the store');

    await press(app, 'H');
    await eventually(() => expect(app.lastFrame()).toContain('Implement the store'));
  });

  test('the Tasks footer offers H, its label saying what the next press does', async () => {
    const { app } = await started(factoryState([task('T1', 'Implement the store', 'running', 'Running'), task('T2', 'Settle the glossary', 'done', 'Done')]));
    const footer = () => app.lastFrame()!.split('\n').slice(-3).join(' ');

    await eventually(() => expect(footer()).toContain('H hide finished'));
    await press(app, 'H');
    await eventually(() => expect(footer()).toContain('H show finished'));
    await press(app, 'H');
    await eventually(() => expect(footer()).toContain('H hide finished'));
  });

  test('H is remembered: the TUI starts as the last session left it, and each press saves it', async () => {
    const tasks = () => factoryState([task('T1', 'Implement the store', 'running', 'Running'), task('T2', 'Settle the glossary', 'done', 'Done')]);
    const prefs = memoryPrefs({ hideFinished: true });
    const { app } = await started(tasks(), { prefs });

    await eventually(() => {
      expect(app.lastFrame()).toContain('Implement the store');
      expect(app.lastFrame()).toContain('1 finished hidden · H shows them');
    });
    expect(app.lastFrame()).not.toContain('Settle the glossary');
    expect(prefs.saved).toEqual([]);

    // Typed in one burst: each press goes on from the last.
    app.stdin.write('H');
    app.stdin.write('H');
    app.stdin.write('H');
    await eventually(() => expect(prefs.saved).toEqual([{ hideFinished: false }, { hideFinished: true }, { hideFinished: false }]));
    await eventually(() => expect(app.lastFrame()).toContain('Settle the glossary'));

    // The next session starts with them shown.
    const { app: next } = await started(tasks(), { prefs });
    await eventually(() => expect(next.lastFrame()).toContain('Settle the glossary'));
  });

  test('a answers the selected task’s request: from the Tasks screen or a task’s detail it goes to Needs you, the digits on that request', async () => {
    const failure = (taskId: string, requestId: string): FactoryState['attentionQueue'][number] => ({
      kind: 'attention', recovery: null, deniedHosts: null, skipped: null, taskId, repo: 'acme/widgets', requestId, attention: 'failure', holdsRun: false, reason: 'The agent hit max turns.', question: null, permission: null,
    });
    const failing = task('T2', 'Implement the store', 'waiting', 'Needs you');
    const { app, connection } = await started(factoryState([{ ...grilling, state: 'waiting', label: 'Needs you' }, failing], [failure('T1', 'A1'), failure('T2', 'A2')]));

    // T2, the newest, is on top.
    await press(app, 'a');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/› failure T2 Implement the store/));
    await press(app, '1');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T2' }));

    await press(app, '\x1b', '1', '\x1b[B', '\r', 'a');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toMatch(/› failure T1 Grill me about the docs/));
    await press(app, '1');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1' }));
  });

  test('c and x act on the task drilled into, on the Runs screen on the run’s task, and on Needs you on the item’s task', async () => {
    const { app, connection } = await started({
      ...factoryState([grilling, implementing], [{ kind: 'ready', taskId: 'T1' }]),
      runs: { R3: ran('R3', 'T2', 5, { status: 'active', outcome: null, endedAt: null }) },
    });

    await press(app, '2', 'x');
    await eventually(() => expect(connection.sent).toEqual([{ type: 'cancel', taskId: 'T1' }]));
    connection.sent.length = 0;

    await press(app, '3', 'x');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'cancel', taskId: 'T2' }));
    await press(app, '\r', 'x');
    await eventually(() => expect(connection.sent).toHaveLength(2));
    expect(connection.sent.at(-1)).toEqual({ type: 'cancel', taskId: 'T2' });
    await press(app, 'c');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'takeOver', taskId: 'T2' }));
  });

  test('? shows every key until ? or esc closes it, and meanwhile the keys do nothing else', async () => {
    const { app } = await started(screens());

    await press(app, '?');
    await eventually(() => {
      const frame = app.lastFrame()!;
      for (const key of ['1–4', 'enter', 'esc', 'N', 'a', 'c', 'x', 'H', 'v', 'tab', 'f', ':', 'g', '\\?']) expect(frame).toMatch(new RegExp(`^[│\\s]*${key}\\s{2,}\\S`, 'm'));
      // Its own hint says what closes it, once, under the last key it lists
      // and not on the footer, the screen's last line, which gives way to it.
      const lines = frame.trimEnd().split('\n');
      const hint = lines.findIndex((line) => line.includes('? or esc close'));
      expect(lines.filter((line) => line.includes('? or esc close'))).toHaveLength(1);
      expect(hint).toBeGreaterThan(lines.findIndex((line) => /\?\s{2,}this help/.test(line)));
      expect(hint).toBeLessThan(lines.length - 1);
    });
    await press(app, '3', '\x1b');
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+\S\s+T2\s+Implement the store/));

    await press(app, '?', '?');
    await eventually(() => expect(app.lastFrame()).not.toMatch(/^\s*enter\s{2,}/m));
  });
});

// The built-in wayfinder preset, frozen: chart, its work loop, then main-flow from spec.
const stage = (id: string, more: object = {}) => ({ id, kind: 'run' as const, skill: id, mode: 'HITL' as const, model: 'opus' as const, ...more });
const wayfinder = {
  name: 'wayfinder',
  description: null,
  source: 'built-in' as const,
  path: 'wayfinder.preset.yaml',
  hash: '0123456789abcdef',
  repoCommit: 'c0ffee',
  stages: [
    stage('chart', { exit: 'artifact:map' }),
    { id: 'work', kind: 'loop' as const, skill: 'wayfinder', mode: 'HITL' as const, model: 'opus' as const, exit: 'map-cleared' },
    stage('spec', { exit: 'artifact:spec' }),
    stage('tickets', { exit: 'artifact:tickets' }),
    { id: 'implement', kind: 'tickets' as const, skill: 'implement', mode: 'AFK' as const, model: 'sonnet' as const, exit: 'spec-closed' },
  ],
};

describe('the wayfinder work loop', () => {
  const frontier = [
    { ref: 'acme/widgets#31', title: 'Which payment provider?' },
    { ref: 'acme/widgets#33', title: 'Invoice layout' },
  ];
  const picking: TaskView = {
    ...task('T1', 'Overhaul billing', 'queued', 'Ready for you', 'HITL'),
    preset: wayfinder,
    stage: 'work',
    loop: { ticket: null, frontier, cleared: false },
  };
  const cleared: TaskView = { ...picking, loop: { ticket: null, frontier: null, cleared: true } };
  const ready = [{ kind: 'ready' as const, taskId: 'T1' }];

  test('the frontier tickets show under the task in Ready for you, and a digit picks one into its conversation', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([picking], ready), { connection });
    await press(app, '2');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain('YOUR TURN Ready for you [1] acme/widgets#31 Which payment provider? [2] acme/widgets#33 Invoice layout a answer'),
    );

    await press(app, 'a', '2');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'open', taskId: 'T1', ticket: 'acme/widgets#33' }));
    await eventually(() => expect(app.lastFrame()).toContain('ctrl+b back'));
  });

  test('1 takes the first frontier ticket', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([picking], ready), { connection });

    await press(app, '2', 'a', '1');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'open', taskId: 'T1', ticket: 'acme/widgets#31' }));
  });

  test('c opens the task on its first frontier ticket, but not once its map has cleared', async () => {
    const { app: done, connection: none } = await started(factoryState([cleared]));
    await press(done, 'c');
    await settle();
    expect(none.sent).toEqual([]);

    const { app, connection } = await started(factoryState([picking]));
    await press(app, 'c');
    await eventually(() => expect(connection.sent).toEqual([{ type: 'open', taskId: 'T1' }]));
  });

  test('a cleared map offers continue to spec, jump to tickets or end, each sent as the advance it is', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([cleared], ready), { connection });
    await press(app, '2');
    await eventually(() =>
      expect(unwrapped(app.lastFrame()!)).toContain('Ready for you: the map has cleared [1] Continue to spec [2] Jump to tickets [3] End: put T1 in review a answer'),
    );

    await press(app, 'a', '3');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'advanceStage', taskId: 'T1', end: true }));
  });

  test('jumping to tickets skips the spec', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([cleared], ready), { connection });

    await press(app, '2', 'a', '2');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'advanceStage', taskId: 'T1', skip: ['spec'] }));
  });

  test('continuing to spec goes into its conversation', async () => {
    const connection = new FakeConnection();
    const { app } = await started(factoryState([cleared], ready), { connection });

    await press(app, '2', 'a', '1');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'advanceStage', taskId: 'T1' }));
    await eventually(() => expect(app.lastFrame()).toContain('ctrl+b back'));
  });

  test('in a ticket’s conversation, the advance sheet finishes the ticket', async () => {
    const connection = new FakeConnection();
    const working = { ...picking, state: 'running' as const, label: 'In conversation', liveRunId: 'R1', loop: { ticket: 'acme/widgets#31', frontier: null, cleared: false } };
    const run = {
      id: 'R1', taskId: 'T1', mode: 'HITL' as const, autonomy: null, status: 'active' as const, outcome: null, interruption: null, turn: 'operator' as const, queued: [] as string[],
      question: null, permission: null, stage: 'work', ticket: null, proposal: null, tier: 'opus' as const, model: 'claude-opus-5-5', maxTurns: null, cli: null, skillSet: null, startedAt: 1, endedAt: null, usage: {}, deniedHosts: [] as string[], waitingForWindow: null,
    };
    const { app } = await started({ ...factoryState([working]), runs: { R1: run } }, { connection });
    await press(app, '\r', '\r');
    await settle();

    app.stdin.write('\x0e');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('Finish acme/widgets#31: the factory reads the map again for its next frontier.'));
    app.stdin.write('\r');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'advanceStage', taskId: 'T1' }));
  });
});

describe('a stalled work loop', () => {
  test('offers to read the map again once its blockers move, or cancel', async () => {
    const connection = new FakeConnection();
    const stalled: TaskView = { ...task('T1', 'Overhaul billing', 'waiting', 'Needs you', 'HITL'), preset: wayfinder, stage: 'work', loop: { ticket: null, frontier: null, cleared: false } };
    const blocked = {
      kind: 'attention' as const, recovery: null, deniedHosts: null, skipped: null, taskId: 'T1', repo: 'acme/widgets', requestId: 'A1', attention: 'stage-blocked' as const, holdsRun: false,
      reason: 'work’s map has no frontier: every open ticket is blocked (acme/widgets#31 by acme/widgets#39).', question: null, permission: null,
    };
    const { app } = await started(factoryState([stalled], [blocked]), { connection });
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('acme/widgets#39). [1] Read the map again [2] Cancel a answer'));

    await press(app, 'a', '1');

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1' }));
  });

  test('once the map has cleared, a next stage that couldn’t start is only dismissed: nothing is read again', async () => {
    const connection = new FakeConnection();
    const blockedNext: TaskView = { ...task('T1', 'Overhaul billing', 'waiting', 'Needs you', 'HITL'), preset: wayfinder, stage: 'work', loop: { ticket: null, frontier: null, cleared: true } };
    const blocked = {
      kind: 'attention' as const, recovery: null, deniedHosts: null, skipped: null, taskId: 'T1', repo: 'acme/widgets', requestId: 'A1', attention: 'stage-blocked' as const, holdsRun: false,
      reason: 'spec can’t start: its args need {{artifacts.map}}, and T1 has no map.', question: null, permission: null,
    };
    const { app } = await started(factoryState([blockedNext], [blocked]), { connection });
    await press(app, '2');

    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('has no map. [1] Dismiss a answer'));
  });
});

describe('a spec task left with skipped tickets', () => {
  test('offers to relaunch each skipped ticket, end leaving the spec open, close the spec anyway, or cancel', async () => {
    const connection = new FakeConnection();
    const stalled: TaskView = {
      ...task('T1', 'Sign-in', 'waiting', 'Needs you', 'AFK'),
      kind: 'spec',
      stage: 'implement',
      ticketSet: { spec: 'acme/widgets#10', tickets: [{ ref: 'acme/widgets#11', title: 'A login form', state: 'skipped' }], problem: null },
    };
    const asked = {
      kind: 'attention' as const, recovery: null, deniedHosts: null, skipped: ['acme/widgets#11'], taskId: 'T1', repo: 'acme/widgets', requestId: 'A1', attention: 'stage-blocked' as const, holdsRun: false,
      reason: 'implement can launch no more tickets: acme/widgets#11 was skipped when its ticket task was cancelled.', question: null, permission: null,
    };
    const { app } = await started(factoryState([stalled], [asked]), { connection });
    await press(app, '2');
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('[1] Relaunch acme/widgets#11 [2] End, leaving the spec open [3] Close the spec anyway [4] Cancel'));

    await press(app, 'a', '1');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'answer', taskId: 'T1', relaunch: 'acme/widgets#11' }));
  });
});

describe('quick launch', () => {
  const widgets = { id: 'acme/widgets', path: '/clones/widgets', baseBranch: 'main', defaultPreset: 'main-flow', missing: false, app: null, skills: null };
  const prompt = 'Add a --json flag to status.';
  const grilling: TaskView = {
    ...task('T1', prompt, 'running', 'In conversation', 'HITL'),
    liveRunId: 'R1',
    stage: 'grill',
    sessionId: '5f0c2a8e-3b1d-4c6e-9a7f-2d8b4e1c0a93',
    quick: { questions: 0, done: false },
  };
  const run: RunView = {
    id: 'R1',
    taskId: 'T1',
    mode: 'HITL',
    autonomy: null,
    status: 'active',
    outcome: null,
    interruption: null,
    turn: 'agent',
    queued: [],
    question: null,
    permission: null,
    stage: 'grill',
    ticket: null,
    proposal: null,
    tier: 'opus',
    model: 'claude-opus-5-5',
    maxTurns: null,
    cli: { pid: 4242, createdAt: 1 },
    skillSet: null,
    startedAt: 1,
    endedAt: null,
    usage: {},
    deniedHosts: [], waitingForWindow: null,
  };
  const question = {
    id: 'toolu_1',
    questions: [
      {
        question: 'Same fields as the table?',
        header: 'Fields',
        options: [
          { label: 'Yes', description: 'One schema' },
          { label: 'No', description: 'Raw records' },
        ],
        multiSelect: false,
      },
    ],
  };
  const sheet = {
    brief: { goal: 'status --json prints JSON.', decided: [], doneWhen: [], outOfScope: [], links: [] },
    stage: 'implement',
    continueAs: 'resume' as const,
    autonomy: 'L1' as const,
    tier: 'sonnet' as const,
    maxTurns: 300,
    contextShare: null,
    readiness: { blockers: [], toCommit: [] },
  };
  const CTRL_H = '\x1b[104;5u';
  const CTRL_E = '\x05';

  // The TUI in the widgets clone, `n` pressed, the prompt typed and launched
  // as T1, now grilling on R1.
  async function launched(runView: RunView = run) {
    const connection = new FakeConnection();
    connection.replyTo('inspectClone', { ok: true, value: { repo: 'acme/widgets', path: widgets.path } });
    connection.replyTo('launchTask', { ok: true, value: { taskId: 'T1' } });
    const { app } = await started({ ...factoryState([]), repositories: { 'acme/widgets': widgets } }, { cwd: '/clones/widgets', connection });
    app.stdin.write('n');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/QUICK LAUNCH[\s\S]*acme\/widgets/));
    for (const char of prompt) app.stdin.write(char);
    await settle();
    app.stdin.write('\r');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'launchTask', repo: 'acme/widgets', preset: 'quick', prompt, quick: true }));
    connection.servePatch([
      { op: 'set', path: ['tasks', 'T1'], value: grilling },
      { op: 'set', path: ['runs', 'R1'], value: runView },
    ]);
    await settle();
    connection.sent.length = 0;
    return { connection, app };
  }

  // The TUI in the widgets clone, `n` pressed and the prompt launched, the
  // daemon not yet answering: `answer` answers it.
  async function launching() {
    const connection = new FakeConnection();
    connection.replyTo('inspectClone', { ok: true, value: { repo: 'acme/widgets', path: widgets.path } });
    const answer = connection.holdReplies('launchTask');
    const { app } = await started({ ...factoryState([]), repositories: { 'acme/widgets': widgets } }, { cwd: '/clones/widgets', connection });
    app.stdin.write('n');
    await settle();
    await eventually(() => expect(app.lastFrame()).toMatch(/QUICK LAUNCH[\s\S]*acme\/widgets/));
    for (const char of prompt) app.stdin.write(char);
    await settle();
    app.stdin.write('\r');
    return { app, connection, answer };
  }

  test('while the daemon names the launch, the quick launch shows a turning spinner, and a second enter launches nothing more', async () => {
    const { app, connection, answer } = await launching();

    await spinsWhileLaunching(app, connection);

    answer({ ok: true, value: { taskId: 'T1' } });
    await eventually(() => expect(app.lastFrame()).toContain('Starting the grill…'));
    expect(app.lastFrame()).not.toContain('Naming the task…');
  });

  test('esc while the daemon names the launch leaves, and the grill launched meanwhile goes on as a conversation', async () => {
    const { app, connection, answer } = await launching();
    await eventually(() => expect(app.lastFrame()).toContain('Naming the task…'));

    app.stdin.write('\x1b');
    await eventually(() => expect(app.lastFrame()).not.toContain('Naming the task…'));
    answer({ ok: true, value: { taskId: 'T1' } });

    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'expandQuickLaunch', taskId: 'T1' }));
  });

  test('n takes one prompt into a small card that shows the agent’s question, which a digit answers', async () => {
    const { app, connection } = await launched({ ...run, question });

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/QUICK LAUNCH T1[\s\S]*Same fields as the table\?[\s\S]*\[1\]\s+Yes\s+One schema/);
      expect(frame).toContain('ctrl+e full conversation');
      // The card, not the full conversation view.
      expect(frame).not.toContain('claude --resume');
    });
    app.stdin.write('1');

    await eventually(() =>
      expect(connection.sent).toEqual([{ type: 'answerQuestion', taskId: 'T1', questionId: 'toolu_1', answers: { 'Same fields as the table?': 'Yes' } }]),
    );
  });

  test('it ends on the handoff sheet at L1, and once handed off the card closes onto the task list', async () => {
    const { app, connection } = await launched();
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: { ...grilling, quick: null, handoff: sheet } }]);
    await eventually(() => {
      const frame = unwrapped(app.lastFrame()!);
      expect(frame).toContain('HAND OFF T1 TO IMPLEMENT (AFK)');
      expect(frame).toContain('Autonomy ‹ L1 (on this machine) ›');
    });

    // Its keys reach the sheet once it has mounted, a moment after its first frame.
    await settle();
    app.stdin.write('\r');
    await eventually(() => expect(connection.sent).toMatchObject([{ type: 'handoff', taskId: 'T1', autonomy: 'L1' }]));
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: { ...grilling, mode: 'AFK', autonomy: 'L1', state: 'queued', label: 'Queued', quick: null, handoff: null } }]);

    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).not.toContain('HAND OFF T1');
      expect(frame).toMatch(/T1\s+Add a --json flag to status\.\s+AFK L1\s+Queued/);
    });
  });

  test('a handoff sheet taller than the screen keeps its fields, hint and the footer in view', async () => {
    const { app, connection } = await launched();
    Object.defineProperty(app.stdout, 'rows', { value: 24, configurable: true });
    app.stdout.emit('resize');
    const long = { ...sheet.brief, decided: Array.from({ length: 40 }, (_, i) => `Decision ${i}.`) };
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: { ...grilling, quick: null, handoff: { ...sheet, brief: long } } }]);
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      const flat = unwrapped(frame);
      expect(flat).toContain('HAND OFF T1 TO IMPLEMENT (AFK)');
      expect(flat).toContain('Goal status --json prints JSON.');
      expect(flat).not.toContain('Decision 39.');
      expect(flat).toContain('Max turns 300');
      expect(flat).toContain('esc keep talking');
      expect(flat).toContain('slots ○○ 0/2');
    });
  });

  test('ctrl+h at a question opens the handoff sheet', async () => {
    const { app, connection } = await launched({ ...run, question });
    await eventually(() => expect(app.lastFrame()).toContain('Same fields as the table?'));

    app.stdin.write(CTRL_H);

    await eventually(() => expect(connection.sent).toEqual([{ type: 'openHandoff', taskId: 'T1' }]));
  });

  test('ctrl+e expands the card into the full conversation on the same session', async () => {
    const { app, connection } = await launched({ ...run, question });
    await eventually(() => expect(app.lastFrame()).toContain('Same fields as the table?'));

    app.stdin.write(CTRL_E);

    await eventually(() => expect(connection.sent).toEqual([{ type: 'expandQuickLaunch', taskId: 'T1' }]));
    await eventually(() => {
      expect(connection.conversed).toEqual(['R1']);
      expect(app.lastFrame()).toContain('claude --resume 5f0c2a8e-3b1d-4c6e-9a7f-2d8b4e1c0a93');
    });
  });

  test('backing out of its handoff sheet keeps the conversation going, in the full conversation view', async () => {
    const { app, connection } = await launched();
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: { ...grilling, quick: null, handoff: sheet } }]);
    await eventually(() => expect(unwrapped(app.lastFrame()!)).toContain('HAND OFF T1'));

    app.stdin.write('\x1b');
    await eventually(() => expect(connection.sent).toEqual([{ type: 'closeHandoff', taskId: 'T1' }]));
    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: { ...grilling, quick: null } }]);

    await eventually(() => expect(app.lastFrame()).toContain('claude --resume'));
  });

  test('esc on a launched card leaves it as an ordinary conversation, back on the task list', async () => {
    const { app, connection } = await launched({ ...run, question });
    await eventually(() => expect(app.lastFrame()).toContain('Same fields as the table?'));

    app.stdin.write('\x1b');

    await eventually(() => expect(connection.sent).toEqual([{ type: 'expandQuickLaunch', taskId: 'T1' }]));
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).not.toContain('QUICK LAUNCH');
      expect(frame).toMatch(/T1\s+Add a --json flag to status\.\s+HITL\s+In conversation/);
    });
  });

  test('a quick launch cancelled meanwhile closes its card', async () => {
    const { app, connection } = await launched();
    await eventually(() => expect(app.lastFrame()).toContain('QUICK LAUNCH T1'));

    connection.servePatch([{ op: 'set', path: ['tasks', 'T1'], value: { ...grilling, state: 'cancelled', label: 'Cancelled', liveRunId: null } }]);

    await eventually(() => expect(app.lastFrame()).not.toContain('QUICK LAUNCH T1'));
  });

  test('esc on the prompt backs out without launching', async () => {
    const connection = new FakeConnection();
    const { app } = await started({ ...factoryState([]), repositories: { 'acme/widgets': widgets } }, { connection });
    app.stdin.write('n');
    await eventually(() => expect(app.lastFrame()).toContain('QUICK LAUNCH'));

    app.stdin.write('\x1b');

    await eventually(() => expect(app.lastFrame()).not.toContain('QUICK LAUNCH'));
    expect(connection.sent).toEqual([]);
  });
});

describe('the condensed view', () => {
  const failure = (taskId: string, requestId: string): FactoryState['attentionQueue'][number] => ({
    kind: 'attention', recovery: null, deniedHosts: null, skipped: null, taskId, repo: 'acme/widgets', requestId, attention: 'failure', holdsRun: false, reason: 'The agent hit max turns.', question: null, permission: null,
  });
  const billing = { ...task('T1', 'Grill me about invoices', 'queued', 'Ready for you', 'HITL'), groups: ['billing'] };
  const failing = { ...task('T2', 'Implement the store', 'waiting', 'Needs you'), groups: ['billing', 'store'] };
  const docs = { ...task('T3', 'Write the docs', 'running', 'Running'), groups: ['docs'] };
  const condensed = () => factoryState([billing, failing, docs], [failure('T2', 'A2'), { kind: 'ready', taskId: 'T1' }]);

  test('v toggles between the screens and the condensed view over the same state: sidebar, task tree and the selected task’s detail', async () => {
    const { app } = await started(condensed());
    await press(app, '\x1b[B', 'v');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).not.toMatch(/1 Tasks\s+2 Needs you/);
      // The sidebar: Needs you, then each group with its tasks counted.
      expect(frame).toMatch(/Needs you \(2\)/);
      expect(frame).toMatch(/GROUPS/);
      expect(frame).toMatch(/billing\s+2/);
      expect(frame).toMatch(/docs\s+1/);
      expect(frame).toMatch(/store\s+1/);
      // The tree, the cursor still on T2, and T2's detail beside it.
      expect(frame).toMatch(/›\s+\S\s+T2\s+Implement the/);
      expect(frame).toContain('Write the docs');
      expect(frame).toContain('OUTPUT · T2');
    });

    // T3, the newest, is above it.
    await press(app, '\x1b[A');
    await eventually(() => expect(app.lastFrame()).toContain('OUTPUT · T3'));

    await press(app, 'v');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/1 Tasks\s+2 Needs you \(2\)/);
      expect(frame).toMatch(/›\s+\S\s+T3\s+Write the docs/);
      expect(frame).not.toMatch(/^\s*GROUPS/m);
    });
  });

  test('the condensed view’s panes sit under their titles, divided by │ rather than boxed, and its keys are the footer', async () => {
    const { app } = await started(condensed());
    await press(app, 'v');
    await eventually(() => {
      const frame = app.lastFrame()!;
      const lines = frame.split('\n');
      // The titles share a row: the sidebar's, then the tree's and the detail's, each after a divider.
      expect(frame).toMatch(/NEEDS YOU \(2\)\s+│\s+TASKS · all\s+│\s+DETAIL/);
      expect(frame).toMatch(/^\s*GROUPS/m);
      // The panes are divided, not boxed: no square corners. (The detail's
      // own sections are rounded boxes, as task detail draws them.)
      expect(frame).not.toMatch(/[┌┐└┘]/);
      expect(lines.at(-1)).toMatch(/^tab focus · f zoom · g group · : command · v screens · \? keys/);
    });

    await press(app, 'f');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/^\s*DETAIL · zoomed/m);
      expect(frame).not.toContain('TASKS · all');
    });
  });

  test('the condensed view’s detail leaves out the usage and artifacts, zoomed or not, the live output taking their rows', async () => {
    const writing = { ...docs, liveRunId: 'R1' };
    const runs = { R1: ran('R1', 'T3', 1, { status: 'active', outcome: null, endedAt: null }) };
    const { app, connection } = await started({ ...factoryState([billing, failing, writing]), runs });
    resize(app, 40);
    // More events than any detail has rows for, so the output fills what it gets.
    const steps = Array.from({ length: 60 }, (_, i) => ({ type: 'message' as const, id: `E${i + 1}`, from: 'agent' as const, text: `Step ${i + 1} done.` }));
    const shown = () => lines(app).filter((line) => /Step \d+ done\./.test(line)).length;

    await press(app, 'v');
    await eventually(() => expect(connection.followed.at(-1)).toBe('R1'));
    connection.serveConversation('R1', ...steps);
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('LIVE OUTPUT · T3 · R1');
      expect(frame).toContain('Step 60 done.');
      expect(frame).toMatch(/─ RUNS ─/);
      expect(frame).not.toMatch(/─ USAGE ─/);
      expect(frame).not.toMatch(/─ ARTIFACTS ─/);
    });

    await press(app, 'f');
    await eventually(() => {
      const frame = app.lastFrame()!;
      // Zoomed, the detail alone: no tree beside it.
      expect(frame).not.toContain('TASKS · all');
      expect(frame).toMatch(/^\s*T3 Write the docs$/m);
      expect(frame).toContain('Step 60 done.');
      expect(frame).not.toMatch(/─ USAGE ─/);
      expect(frame).not.toMatch(/─ ARTIFACTS ─/);
    });
    const zoomed = shown();

    // Drilled into from the screens, T3's detail keeps them, and its output
    // has their rows the fewer.
    const follows = connection.followed.length;
    await press(app, 'f', 'v', '\r');
    await eventually(() => expect(connection.followed.length).toBeGreaterThan(follows));
    connection.serveConversation('R1', ...steps);
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('Tasks › T3 Write the docs');
      expect(frame).toMatch(/^\s*T3 Write the docs$/m);
      expect(frame).toMatch(/─ USAGE ─/);
      expect(frame).toMatch(/─ ARTIFACTS ─/);
      expect(frame).toContain('Step 60 done.');
    });
    expect(zoomed).toBeGreaterThanOrEqual(shown() + 4);
  });

  test('tab moves the focus from the tree to the detail, then the sidebar, the verbs acting on the focused pane’s task; f zooms the detail', async () => {
    const { app, connection } = await started(condensed());
    // T1, the oldest, at the bottom: T3, T2, T1.
    await press(app, 'v', '\x1b[B', '\x1b[B');
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+\S\s+T1\s+Grill me/));

    // The detail: the cursor leaves the tree, and x cancels the task it shows.
    await press(app, '\t');
    await eventually(() => expect(app.lastFrame()).not.toContain('›'));
    await press(app, 'x');
    await eventually(() => expect(connection.sent).toEqual([{ type: 'cancel', taskId: 'T1' }]));

    // The sidebar: its cursor on the first item, and the detail follows it.
    await press(app, '\t');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/›\s+T2\s+failure/);
      expect(frame).toMatch(/│\s+T2\s+Implement the store\s*$/m);
    });
    await press(app, '\x1b[B');
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+T1\s+Ready for you/));

    // Back to the tree, where the cursor was.
    await press(app, '\t');
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+\S\s+T1\s+Grill me/));

    await press(app, 'f');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).not.toContain('GROUPS');
      expect(frame).not.toContain('Write the docs');
      expect(frame).toContain('OUTPUT · T1');
    });
    await press(app, 'f');
    await eventually(() => expect(app.lastFrame()).toContain('GROUPS'));
    await press(app, 'f', '\x1b');
    await eventually(() => expect(app.lastFrame()).toContain('GROUPS'));
  });

  test('g picks a group and the task tree shows only its tasks, in both views; All tasks clears it and esc backs out', async () => {
    const { app } = await started(condensed());

    await press(app, 'g');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/FILTER BY GROUP/);
      expect(frame).toMatch(/›\s+All tasks/);
      expect(frame).toMatch(/billing\s+2/);
      expect(frame).toMatch(/docs\s+1/);
    });
    // Meanwhile the keys do nothing else.
    await press(app, '3');
    await press(app, '\x1b[B', '\r');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).not.toContain('FILTER BY GROUP');
      expect(frame).toContain('1 Tasks');
      expect(frame).toContain('group: billing');
      expect(frame).toContain('Grill me about invoices');
      expect(frame).toContain('Implement the store');
      expect(frame).not.toContain('Write the docs');
    });

    await press(app, 'v');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/•\s+billing/);
      expect(frame).not.toContain('Write the docs');
    });

    await press(app, 'g', '\x1b[B', '\x1b[B', '\x1b');
    await eventually(() => expect(app.lastFrame()).not.toContain('FILTER BY GROUP'));
    expect(app.lastFrame()).not.toContain('Write the docs');

    // The picker opens on the current group: All tasks is above it.
    await press(app, 'g', '\x1b[A', '\r');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('Write the docs');
      expect(frame).not.toContain('group: billing');
    });
  });

  test('a group keeps a child’s parent in its tree, and a factory without groups says so', async () => {
    const { app } = await started(factoryState([task('T1', 'Write the spec', 'running', 'Running'), { ...task('T2', 'Check the links', 'running', 'Running'), parent: 'T1', depth: 1, groups: ['links'] }, task('T3', 'Ship it', 'queued', 'Queued')]));
    await press(app, 'g', '\x1b[B', '\r');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('Write the spec');
      expect(frame).toContain('Check the links');
      expect(frame).not.toContain('Ship it');
    });

    const { app: bare } = await started(factoryState([task('T1', 'Write the spec', 'running', 'Running')]));
    await press(bare, 'g');
    await eventually(() => expect(bare.lastFrame()).toContain('No task has a group yet.'));
  });

  test(': opens the command line: :task <id> drills into a task’s detail, :group <name> filters by it and :group alone clears it', async () => {
    const { app, connection } = await started(condensed());

    // Typed on the command line, keys do nothing else: x cancels nothing.
    // T1, the oldest, is the bottom row: the jump moves the cursor down to it.
    await press(app, ':', 't', 'a', 's', 'x', '\x7f', 'k', ' ', '1');
    await eventually(() => expect(app.lastFrame()).toMatch(/^│ :task 1/m));
    expect(connection.sent).toEqual([]);
    await press(app, '\r');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('Tasks › T1 Grill me about invoices');
      expect(frame).not.toContain('COMMAND');
    });

    await press(app, ':');
    for (const key of 'group billing') await press(app, key);
    await press(app, '\r');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('group: billing');
      expect(frame).not.toContain('Tasks ›');
      expect(frame).not.toContain('Write the docs');
    });

    await press(app, ':');
    for (const key of 'group') await press(app, key);
    await press(app, '\r');
    await eventually(() => expect(app.lastFrame()).toContain('Write the docs'));
    expect(app.lastFrame()).not.toContain('group: billing');

    // esc sets the line aside.
    await press(app, ':', 'q', '\x1b');
    await eventually(() => expect(app.lastFrame()).not.toMatch(/^│ :q/m));
    // The cursor stayed on the task :task jumped to.
    await press(app, 'x');
    await eventually(() => expect(connection.sent).toEqual([{ type: 'cancel', taskId: 'T1' }]));
  });

  test('on the command line, ←→, home and end move the cursor and typing goes in at it', async () => {
    const { app } = await started(condensed());

    await press(app, ':', 's', 'k', ' ', '1', LEFT, LEFT, LEFT, LEFT, 'a', HOME, 't', END);
    await eventually(() => expect(app.lastFrame()).toMatch(/^│ :task 1/m));
    await press(app, '\r');
    await eventually(() => expect(app.lastFrame()).toContain('Tasks › T1 Grill me about invoices'));
  });

  test('the command line says what it can’t do: an unknown command, a task or a group that isn’t there', async () => {
    const { app } = await started(condensed());
    const run = async (line: string) => {
      await press(app, ':');
      for (const key of line) await press(app, key);
      await press(app, '\r');
    };

    await run('frobnicate');
    await eventually(() => expect(app.lastFrame()).toContain('Unknown command :frobnicate. Try :task <id>, :group <name> or :gc.'));
    await run('task 9');
    await eventually(() => expect(app.lastFrame()).toContain('No task T9.'));
    await run('group payroll');
    await eventually(() => expect(app.lastFrame()).toContain('No group payroll.'));
    await run('task t2');
    await eventually(() => expect(app.lastFrame()).toContain('Tasks › T2 Implement the store'));
    expect(app.lastFrame()).not.toContain('No group payroll.');
  });

  test('in the condensed view :task focuses the detail on the task, the tree’s cursor on it', async () => {
    const { app } = await started(condensed());
    // T1, the oldest, is the bottom row: the cursor goes down to it.
    await press(app, 'v', ':');
    for (const key of 'task 1') await press(app, key);
    await press(app, '\r');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/│\s+T1\s+Grill me about invoices\s*$/m);
      expect(frame).not.toContain('›');
    });
    await press(app, '\t', '\t');
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+\S\s+T1\s+Grill me/));
  });

  test('the group picker takes keys typed in one burst, opens on the current group, and shows the Tasks screen it filters', async () => {
    const { app } = await started(condensed());
    await press(app, '3');
    app.stdin.write('g');
    app.stdin.write('\x1b[B');
    app.stdin.write('\r');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('group: billing');
      // Billing's newest first.
      expect(frame).toMatch(/›\s+\S\s+T2\s+Implement the store[\s\S]*T1\s+Grill me about invoices/);
      expect(frame).not.toContain('Write the docs');
    });
    expect(app.lastFrame()).not.toContain('Tasks ›');

    await press(app, 'g');
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+billing\s+2/));
  });

  test('with no task to show, tab skips the detail', async () => {
    const { app } = await started(factoryState([], [failure('T2', 'A2')]));
    await press(app, 'v', '\t');
    await eventually(() => expect(app.lastFrame()).toMatch(/›\s+T2\s+failure/));
  });
});

describe('factory gc from the TUI', () => {
  const leftovers: LeftoversView = {
    leftovers: [
      { leftover: { kind: 'worktree', repo: 'acme/widgets', path: '/worktrees/acme-widgets/T7', branch: 'factory/T7-lost-work' }, why: 'No task of the factory’s has it.' },
      { leftover: { kind: 'branch', repo: 'acme/widgets', branch: 'factory/T7-lost-work' }, why: 'No task of the factory’s has it.' },
      { leftover: { kind: 'container', taskId: 'T2' }, why: 'T2 is Cancelled.' },
    ],
    unlisted: ['Docker couldn’t be reached, so containers and images weren’t looked at: nope.'],
  };

  test(':gc lists the leftovers, nothing ticked, and enter deletes only the ticked ones', async () => {
    const connection = new FakeConnection();
    connection.replyTo('listLeftovers', { ok: true, value: leftovers });
    const [worktree, , container] = leftovers.leftovers.map(({ leftover }) => leftover);
    connection.replyTo('gc', { ok: true, value: { deleted: [worktree], failed: [{ leftover: container, reason: 'Docker said no.' }] } });
    const { app } = await started(factoryState([task('T1', 'Write the spec', 'running', 'Running')]), { connection });

    await press(app, ':', 'g', 'c', '\r');
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toMatch(/›\s+\[ \]\s+worktree\s+\/worktrees\/acme-widgets\/T7 · No task of the factory’s has it\./);
      expect(frame).toMatch(/\[ \]\s+branch\s+factory\/T7-lost-work in acme\/widgets/);
      expect(frame).toMatch(/\[ \]\s+container\s+T2 · T2 is Cancelled\./);
      expect(frame).toContain('Docker couldn’t be reached');
    });
    expect(connection.sent).toEqual([{ type: 'listLeftovers' }]);

    // Keys on the sheet do nothing else: x cancels nothing.
    await press(app, ' ', '\x1b[B', '\x1b[B', 'x', ' ', '\r');
    await eventually(() => expect(connection.sent.at(-1)).toEqual({ type: 'gc', leftovers: [worktree, container] }));
    await eventually(() => {
      const frame = app.lastFrame()!;
      expect(frame).toContain('Deleted 1.');
      expect(frame).toContain('T2’s container: Docker said no.');
    });

    await press(app, '\x1b');
    await eventually(() => expect(app.lastFrame()).not.toContain('Deleted 1.'));
    expect(connection.sent.filter((command) => command.type === 'cancel')).toEqual([]);
  });

  test('a ticks every leftover or none, and esc backs out deleting nothing', async () => {
    const connection = new FakeConnection();
    connection.replyTo('listLeftovers', { ok: true, value: leftovers });
    const { app } = await started(factoryState([]), { connection });

    await press(app, ':', 'g', 'c', '\r', 'a');
    await eventually(() => expect(app.lastFrame()!.match(/\[x\]/g)).toHaveLength(3));
    await press(app, 'a');
    await eventually(() => expect(app.lastFrame()).not.toContain('[x]'));
    await press(app, '\x1b');

    await eventually(() => expect(app.lastFrame()).not.toContain('[ ]'));
    expect(connection.sent).toEqual([{ type: 'listLeftovers' }]);
  });

  test('with no leftovers it says so', async () => {
    const connection = new FakeConnection();
    connection.replyTo('listLeftovers', { ok: true, value: { leftovers: [], unlisted: [] } });
    const { app } = await started(factoryState([]), { connection });

    await press(app, ':', 'g', 'c', '\r');

    await eventually(() => expect(app.lastFrame()).toContain('Nothing is left over: everything belongs to a live task.'));
  });

  test('the sheet `repo remove` opens asks for that repository’s leftovers alone, and says whose they are', async () => {
    const connection = new FakeConnection();
    connection.replyTo('listLeftovers', { ok: true, value: { leftovers: leftovers.leftovers.slice(0, 2), unlisted: [] } });
    const app = render(<GcSheet connection={connection} repo="acme/widgets" onLeave={() => {}} />);
    apps.push(app);

    await eventually(() => expect(app.lastFrame()).toContain('LEFTOVERS IN ACME/WIDGETS'));
    expect(connection.sent).toEqual([{ type: 'listLeftovers', repo: 'acme/widgets' }]);
  });
});
