// Seam 1: a worktree's dependencies, through the client protocol. A run on
// the host starts once the factory has installed its worktree's
// dependencies from the lockfile, so it never goes looking for them in the
// operator's clone (T16). A worktree installs once, and an install that
// fails holds no run back: the run hears why, and may install them itself.
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

// A factory whose task T1's worktree will have a lockfile.
async function withLockfile(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched; worktree: string }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  const worktree = join(factory.paths.worktreeRoot, 'acme-widgets', 'T1');
  factory.dependencies.addLockfile(worktree);
  return { factory, operator, tui, worktree };
}

const grill = { type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' } as const;

// Resolves once every change sent before it has gone through the daemon.
async function settled(connection: FactoryConnection): Promise<void> {
  await connection.send({ type: 'daemon.status' });
}

const minutes = (count: number) => count * 60_000;

describe('a run on the host', () => {
  test('starts once its worktree’s dependencies are installed from the lockfile', async () => {
    const { factory, operator, worktree } = await withLockfile();
    const release = factory.dependencies.holdInstalls();

    await operator.send(grill);
    await settled(operator);
    expect(factory.dependencies.installs).toEqual([worktree]);
    expect(factory.executor.started).toEqual([]);

    release();
    await settled(operator);
    expect(factory.executor.started).toMatchObject([{ runId: 'R1', cwd: worktree }]);
  });

  test('of a worktree already installed installs nothing again', async () => {
    const { factory, operator, tui } = await withLockfile();
    await operator.send(grill);
    await settled(operator);
    factory.executor.report('R1', { type: 'turnEnded' });
    await settled(operator);
    factory.clock.advance(minutes(31));
    await tui.until((state) => state.runs.R1?.status === 'ended');

    await operator.send({ type: 'open', taskId: 'T1' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    await settled(operator);
    expect(factory.executor.started.map((run) => run.runId)).toEqual(['R1', 'R2']);
    expect(factory.dependencies.installs).toHaveLength(1);
  });

  test('at L1 installs them too', async () => {
    const { factory, operator, tui, worktree } = await withLockfile();
    factory.github.addIssue('acme/widgets#12', { labels: ['ready-for-agent'] });

    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', issues: ['#12'] });

    await tui.until((state) => state.tasks.T1?.label === 'Running');
    await settled(operator);
    expect(factory.dependencies.installs).toEqual([worktree]);
    expect(factory.executor.started).toMatchObject([{ runId: 'R1', mode: 'AFK', autonomy: 'L1' }]);
  });

  test('whose install fails starts anyway, its opening saying why', async () => {
    const { factory, operator } = await withLockfile();
    factory.dependencies.failInstalls('`npm ci` failed: ENOTFOUND registry.npmjs.org');

    await operator.send(grill);
    await settled(operator);

    const [started] = factory.executor.started;
    expect(started?.firstMessage).toMatch(/Grill me about the login flow\.\n\n## Factory note\n\n/);
    expect(started?.firstMessage).toContain('`npm ci` failed: ENOTFOUND registry.npmjs.org');
  });

  test('ended while its dependencies install never starts', async () => {
    const { factory, operator, tui } = await withLockfile();
    const release = factory.dependencies.holdInstalls();
    await operator.send(grill);
    await settled(operator);

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });
    await tui.until((state) => state.runs.R1?.status === 'ended');
    release();
    await settled(operator);

    expect(factory.executor.started).toEqual([]);
  });
});
