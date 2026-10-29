// Seam 1: every task freezes the skill set it launched with, and every run
// loads it as the `factory` plugin (ADR 0005).
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const widgets = resolve('/clones/widgets');
const launch = (prompt: string) => ({ type: 'launchTask', repo: 'acme/widgets', prompt }) as const;

describe('freezing the skill set', () => {
  test('a launched task freezes the pinned skill set, and its run loads it as the plugin', async () => {
    const { factory, operator, tui } = await attached();
    factory.skillSets.pin('b2b2b2b2b2b2b2b2');

    await operator.send(launch('Grill me about the login flow.'));

    const state = await tui.until((state) => state.runs.R1 !== undefined);
    expect(state.tasks.T1).toMatchObject({ skillSet: 'b2b2b2b2b2b2b2b2' });
    expect(state.runs.R1).toMatchObject({ skillSet: 'b2b2b2b2b2b2b2b2' });
    expect(factory.executor.started).toMatchObject([{ runId: 'R1', plugin: factory.skillSets.pathOf('b2b2b2b2b2b2b2b2') }]);
  });

  test('a later skills update leaves a launched task, and its later runs, on the version it froze', async () => {
    const { factory, operator, tui } = await attached();
    factory.skillSets.pin('b2b2b2b2b2b2b2b2');
    await operator.send(launch('Grill me about the login flow.'));

    factory.skillSets.pin('c3c3c3c3c3c3c3c3');
    await operator.send({ type: 'handoff', taskId: 'T1', autonomy: 'L1' });
    await operator.send(launch('Grill me about the logout flow.'));

    const state = await tui.until((state) => state.runs.R3 !== undefined);
    expect(state.tasks.T1).toMatchObject({ skillSet: 'b2b2b2b2b2b2b2b2' });
    expect(state.tasks.T2).toMatchObject({ skillSet: 'c3c3c3c3c3c3c3c3' });
    expect(factory.executor.started.map(({ runId, taskId, plugin }) => ({ runId, taskId, plugin }))).toEqual([
      { runId: 'R1', taskId: 'T1', plugin: factory.skillSets.pathOf('b2b2b2b2b2b2b2b2') },
      { runId: 'R2', taskId: 'T1', plugin: factory.skillSets.pathOf('b2b2b2b2b2b2b2b2') },
      { runId: 'R3', taskId: 'T2', plugin: factory.skillSets.pathOf('c3c3c3c3c3c3c3c3') },
    ]);
  });

  test('a launch is refused, with a reason and no worktree, when the skill set can’t be built', async () => {
    const { factory, operator, tui } = await attached();
    factory.skillSets.failBuilds('https://github.com/mattpocock/skills.git has no commit 49dd158.');

    expect(await operator.send(launch('Grill me about the login flow.'))).toEqual({
      ok: false,
      reason: "The skill set couldn't be built: https://github.com/mattpocock/skills.git has no commit 49dd158.",
    });

    await operator.send({ type: 'daemon.status' });
    expect(tui.state().tasks).toEqual({});
    expect(await factory.git.worktrees(widgets)).toEqual([]);
    expect(factory.executor.started).toEqual([]);
  });
});

describe('keeping skill set versions', () => {
  test('a version is kept while an unfinished task references it, and removed once none does', async () => {
    const { factory, operator } = await attached();
    factory.skillSets.pin('b2b2b2b2b2b2b2b2');
    await operator.send(launch('Grill me about the login flow.'));
    factory.skillSets.pin('c3c3c3c3c3c3c3c3');

    await operator.send(launch('Grill me about the logout flow.'));
    expect([...factory.skillSets.built].sort()).toEqual(['b2b2b2b2b2b2b2b2', 'c3c3c3c3c3c3c3c3']);

    await operator.send({ type: 'cancel', taskId: 'T1' });
    await operator.send(launch('Grill me about the signup flow.'));
    expect([...factory.skillSets.built]).toEqual(['c3c3c3c3c3c3c3c3']);
  });

  test('a daemon start removes the versions no unfinished task references', async () => {
    const { factory, operator } = await attached();
    factory.skillSets.pin('b2b2b2b2b2b2b2b2');
    await operator.send(launch('Grill me about the login flow.'));
    factory.skillSets.pin('c3c3c3c3c3c3c3c3');
    await operator.send(launch('Grill me about the logout flow.'));
    await operator.send({ type: 'cancel', taskId: 'T2' });

    await factory.restart();
    const again = await factory.attach();
    await again.send({ type: 'daemon.status' });

    expect([...factory.skillSets.built]).toEqual(['b2b2b2b2b2b2b2b2']);
  });
});
