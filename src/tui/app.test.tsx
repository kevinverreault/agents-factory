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
  return { id, title, mode, autonomy: mode === 'AFK' ? 'L1' : null, groups: [], state, label, liveRunId: null };
}

function factoryState(tasks: TaskView[], attentionQueue: FactoryState['attentionQueue'] = []): FactoryState {
  return { tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), runs: {}, attentionQueue, slots: { active: 0, cap: 2 } };
}

async function started(state?: FactoryState) {
  const connection = new FakeConnection();
  if (state) connection.serveSnapshot(state);
  const app = render(<App connection={connection} />);
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
          { kind: 'attention', taskId: 'T2', requestId: 'A1', attention: 'failure', holdsRun: false, reason: 'The agent hit max turns.' },
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
