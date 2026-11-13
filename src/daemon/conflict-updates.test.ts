// Seam 1: a ticket task's PR while it waits In review (ADR 0013), through the
// client protocol. The PR poll reads it every 2 minutes while any ticket task
// is In review, rather than every 15. When GitHub finds its PR conflicting
// with its base, the factory queues one update run on the task, resuming its
// session, which merges `origin/<base>` into the task branch and resolves
// the conflicts. At L2 the factory pushes what it did; at L1 nothing is
// pushed. One that fails asks the operator as any failed run does.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AutonomyLevel } from '../lifecycle/lifecycle.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const clone = '/clones/widgets';
const TICKET = 'acme/widgets#39';
const MINUTE = 60_000;

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

// The run that started `n`th, once the executor has it.
async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

// Where the task's runs work: its container at L2, else its worktree.
function workdir({ factory, tui }: Factory, autonomy: AutonomyLevel): string {
  return autonomy === 'L2' ? factory.sandbox.workdirOf('T1') : tui.state().tasks.T1!.worktree!;
}

// T1, a ticket task on #39 at `autonomy`, In review with its PR #101 open:
// its implement, review and PR body runs R1 to R3 completed. At L1 the
// operator pushed it and opened the PR.
async function inReview(autonomy: AutonomyLevel): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  factory.github.addIssue(TICKET, { labels: ['ready-for-agent'] });
  const operator = await factory.attach();
  const tui = watch(operator);
  const launched = { factory, operator, tui };
  await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', issues: ['#39'], autonomy });
  await started(factory, 1);
  factory.git.editFile(workdir(launched, autonomy), 'src/login.ts');
  factory.git.commitAll(workdir(launched, autonomy));
  factory.executor.report('R1', { type: 'runCompleted' });
  await started(factory, 2);
  factory.executor.report('R2', { type: 'runCompleted' });
  await started(factory, 3);
  factory.executor.report('R3', { type: 'prBodyWritten', body: 'Adds a login form.' });
  factory.executor.report('R3', { type: 'runCompleted' });
  await tui.until((state) => state.tasks.T1?.label === 'In review');
  if (autonomy === 'L1') await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });
  await tui.until((state) => state.tasks.T1?.pr?.number === 101 && state.tasks.T1.publishing === null);
  return launched;
}

// Another TUI attaching, which makes the daemon read the PRs, once the read
// of T1's PR has reached GitHub and what it found has settled.
async function poll(factory: TestFactory): Promise<void> {
  const reads = factory.github.prReads.length;
  const tui = await factory.attach();
  watch(tui);
  await vi.waitFor(() => expect(factory.github.prReads.length).toBeGreaterThan(reads));
  // Settled behind the read, its base fetch included, the status replies.
  for (let i = 0; i < 3; i++) await tui.send({ type: 'daemon.status' });
}

describe('the PR poll', () => {
  test('reads the PRs every 2 minutes while a ticket task is In review', async () => {
    const { factory, operator, tui } = await inReview('L2');
    factory.github.merge(101);

    factory.clock.advance(MINUTE);
    await operator.send({ type: 'daemon.status' });
    expect(tui.state().tasks.T1?.label).toBe('In review');

    factory.clock.advance(MINUTE);

    await tui.until((state) => state.tasks.T1?.label === 'Done');
  });
});

describe('a ticket task’s conflicting PR', () => {
  test('queues one update run resuming its session, told to merge origin/<base> in, which its L2 container has as fetched', async () => {
    const launched = await inReview('L2');
    const { factory, tui } = launched;
    const moved = factory.git.advanceOrigin(clone, 'main', { 'src/login.ts': 'export const login = 1;\n' });
    factory.github.setMergeable(101, 'conflicting');

    await poll(factory);

    const update = await started(factory, 4);
    expect(update).toMatchObject({ runId: 'R4', mode: 'AFK', resumesSession: true });
    expect(update.firstMessage).toContain('merge `origin/main` into the task branch factory/T1-');
    expect(update.firstMessage).toContain('resolve the conflicts');
    expect(update.firstMessage).toContain('never rebase');
    expect(factory.git.fetchedTip(factory.sandbox.clonePathOf('T1'), 'main')).toBe(moved);
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');

    // While it runs, the task isn't In review: its PR isn't read, so no second one is queued.
    factory.clock.advance(2 * MINUTE);
    await factory.attach().then((again) => again.send({ type: 'daemon.status' }));
    expect(factory.executor.started).toHaveLength(4);
  });

  test('at L2, the factory pushes the task branch once the update run completes, and queues no other until GitHub finds the PR mergeable again', async () => {
    const launched = await inReview('L2');
    const { factory, tui } = launched;
    factory.github.setMergeable(101, 'conflicting');
    await poll(factory);
    await started(factory, 4);
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    const pushes = factory.github.pushes.length;
    factory.git.editFile(workdir(launched, 'L2'), 'src/login.ts', 'export const login = 2;\n');
    factory.git.commitAll(workdir(launched, 'L2'));

    factory.executor.report('R4', { type: 'runCompleted' });

    await tui.until((state) => state.runs.R4?.status === 'ended' && state.tasks.T1?.label === 'In review' && state.tasks.T1.publishing === null);
    expect(factory.git.checked.at(-1)).toMatchObject({ worktreePath: workdir(launched, 'L2') });
    expect(factory.github.pushes).toHaveLength(pushes + 1);
    expect(factory.github.pushes.at(-1)?.tip).toBe(factory.git.branchTip(clone, tui.state().tasks.T1!.branch!));
    expect(tui.state().attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);

    // Still conflicting as GitHub last worked it out: no second update run.
    await poll(factory);
    expect(factory.executor.started).toHaveLength(4);

    // Mergeable, then conflicting again once the base moved on: another one.
    factory.github.setMergeable(101, 'mergeable');
    await poll(factory);
    factory.github.setMergeable(101, 'conflicting');
    await poll(factory);
    await started(factory, 5);
  });

  test('at L1, the update run’s worktree is checked by the git guards, and nothing is pushed once it completes', async () => {
    const launched = await inReview('L1');
    const { factory, tui } = launched;
    const pushes = factory.github.pushes.length;
    factory.github.setMergeable(101, 'conflicting');
    await poll(factory);
    const update = await started(factory, 4);
    expect(update.firstMessage).toContain('merge `origin/main` into the task branch');
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    const worktree = workdir(launched, 'L1');
    factory.git.editFile(worktree, 'src/login.ts', 'export const login = 2;\n');
    factory.git.commitAll(worktree);
    const checks = factory.git.checked.length;

    factory.executor.report('R4', { type: 'runCompleted' });

    await tui.until((state) => state.runs.R4?.status === 'ended' && state.tasks.T1?.label === 'In review');
    expect(factory.git.checked.slice(checks)).toEqual([expect.objectContaining({ worktreePath: worktree })]);
    expect(factory.github.pushes).toHaveLength(pushes);
  });

  test('a failed update run raises the usual failure request', async () => {
    const { factory, tui } = await inReview('L2');
    factory.github.setMergeable(101, 'conflicting');
    await poll(factory);
    await started(factory, 4);
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');

    factory.executor.report('R4', { type: 'runFailed', reason: 'The conflicts in src/login.ts need a decision.' });

    const failed = await tui.until((state) => state.attentionQueue.some((entry) => entry.kind === 'attention' && entry.attention === 'failure'));
    expect(failed.attentionQueue).toContainEqual(
      expect.objectContaining({ kind: 'attention', taskId: 'T1', attention: 'failure', reason: expect.stringContaining('The conflicts in src/login.ts need a decision.') }),
    );
  });

  test('a PR GitHub hasn’t worked out yet queues nothing', async () => {
    const { factory } = await inReview('L2');
    factory.github.setMergeable(101, 'unknown');

    await poll(factory);

    expect(factory.executor.started).toHaveLength(3);
  });
});
