// Seam 1: a red check at an agent policy's merge gate (ADR 0014), through the
// client protocol. Under full-auto, a PR whose checks go red gets one fix
// run, as a conflicting PR gets an update run: it resumes the task's
// session, told which checks failed and where to read them, and the factory
// pushes what it commits, so the gate waits on the new head's checks. Green
// then merges as usual; red again raises a failure request naming the
// checks, and nothing merges until the operator answers it.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const MINUTE = 60_000;
const BUILD = { name: 'build', url: 'https://github.com/acme/widgets/actions/runs/7/job/1' };
const LINT = { name: 'lint', url: null };

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

// One implement run on a brief, at L3 under full-auto.
const fullAuto: LaunchCommand = { type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: 'Add a logout button.', autonomy: 'L3', mergePolicy: 'unattended' };

// The run that started `n`th, once the executor has it.
async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

// Commits `content` to the task's logout file in its container.
function commit(factory: TestFactory, content: string): void {
  const workdir = factory.sandbox.workdirOf('T1');
  factory.git.editFile(workdir, 'src/logout.ts', content);
  factory.git.commitAll(workdir);
}

// A full-auto task launched and worked through its implement, review and PR
// body runs, its PR #101 waiting at its gate, whose checks went red.
async function redAtGate(): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  factory.github.runChecks('acme/widgets', 'pending');
  await operator.send(fullAuto);
  await started(factory, 1);
  commit(factory, 'export {};\n');
  factory.executor.report('R1', { type: 'runCompleted' });
  await started(factory, 2);
  factory.executor.report('R2', { type: 'runCompleted' });
  await started(factory, 3);
  factory.executor.report('R3', { type: 'prBodyWritten', body: 'Adds a logout button.' });
  factory.executor.report('R3', { type: 'runCompleted' });
  await tui.until((state) => state.tasks.T1?.gate?.checks === 'pending');
  factory.github.setChecks(101, 'red', [BUILD, LINT]);
  factory.clock.advance(2 * MINUTE);
  return { factory, operator, tui };
}

describe('a red check at a full-auto gate', () => {
  test('queues exactly one fix run, resuming the task’s session, told the failing checks and where to read them', async () => {
    const { factory, operator, tui } = await redAtGate();

    const fix = await started(factory, 4);
    expect(fix).toMatchObject({ runId: 'R4', mode: 'AFK', resumesSession: true });
    expect(fix.firstMessage).toContain('build (https://github.com/acme/widgets/actions/runs/7/job/1)');
    expect(fix.firstMessage).toContain('lint');
    expect(fix.firstMessage).toContain('PR #101');
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    expect(tui.state().attentionQueue).toEqual([]);

    // While it runs, the PR isn't read: no second fix run is queued.
    factory.clock.advance(2 * MINUTE);
    await operator.send({ type: 'daemon.status' });
    expect(factory.executor.started).toHaveLength(4);
    expect(factory.github.prState(101).state).toBe('open');
  });

  test('pushes what the fix run commits, waits on the new head’s checks, and merges once they are green', async () => {
    const { factory, tui } = await redAtGate();
    await started(factory, 4);
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    const redHead = factory.github.headOf(factory.github.pullRequests[0]!);
    commit(factory, 'export const fixed = true;\n');

    factory.executor.report('R4', { type: 'runCompleted' });

    // The new head runs the repo's CI afresh: pending, until it is green.
    const waiting = await tui.until((state) => state.tasks.T1?.gate?.checks === 'pending');
    expect(waiting.tasks.T1).toMatchObject({ label: 'At merge gate' });
    const newHead = factory.github.headOf(factory.github.pullRequests[0]!);
    expect(newHead).not.toBe(redHead);
    expect(factory.github.checkReads.at(-1)?.head).toBe(newHead);
    expect(factory.github.prWrites).toEqual([]);
    factory.github.setChecks(101, 'green');
    factory.clock.advance(2 * MINUTE);

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(done.attentionQueue).toEqual([]);
    expect(factory.github.prState(101).state).toBe('merged');
    expect(factory.executor.started).toHaveLength(4);
  });

  test('red again after the fix run raises a failure request naming the checks, and nothing merges', async () => {
    const { factory, operator, tui } = await redAtGate();
    await started(factory, 4);
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    commit(factory, 'export const fixed = false;\n');
    factory.executor.report('R4', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.gate?.checks === 'pending');

    factory.github.setChecks(101, 'red', [LINT]);
    factory.clock.advance(2 * MINUTE);

    const asked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(asked.attentionQueue).toEqual([
      expect.objectContaining({
        kind: 'attention',
        taskId: 'T1',
        attention: 'failure',
        reason: 'The checks on PR #101 of T1 are still failing after its fix run: lint. Fix them and push to the task branch, then answer to send the task back to its merge gate.',
      }),
    ]);
    expect(asked.tasks.T1).toMatchObject({ label: 'At merge gate', gate: { checks: 'red' } });
    // Polled meanwhile, neither a second fix run nor a second request.
    factory.clock.advance(2 * MINUTE);
    await operator.send({ type: 'daemon.status' });
    expect(factory.executor.started).toHaveLength(4);
    expect(tui.state().attentionQueue).toHaveLength(1);
    expect(factory.github.prState(101).state).toBe('open');
    expect(factory.github.prWrites).toEqual([]);
  });

  test('answering the failure request, once the operator pushed a fix, sends the task back to its gate, which merges once the checks are green', async () => {
    const { factory, operator, tui } = await redAtGate();
    await started(factory, 4);
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    factory.executor.report('R4', { type: 'runCompleted' });
    // The fix run committed nothing: the same head is still red.
    await tui.until((state) => state.attentionQueue.length === 1);
    // The operator fixes it by hand: GitHub's head has green checks, though
    // the factory waits for the answer before it merges.
    factory.github.setChecks(101, 'green');
    factory.clock.advance(2 * MINUTE);
    await operator.send({ type: 'daemon.status' });
    expect(factory.github.prState(101).state).toBe('open');

    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(done.attentionQueue).toEqual([]);
    expect(factory.github.prState(101).state).toBe('merged');
    expect(factory.executor.started).toHaveLength(4);
  });

  test('a fix run that fails ends with the normal failure request, and the PR isn’t merged', async () => {
    const { factory, tui } = await redAtGate();
    await started(factory, 4);
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');

    factory.executor.report('R4', { type: 'runFailed', reason: 'The run hit its turn limit.' });

    const asked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(asked.attentionQueue).toEqual([expect.objectContaining({ kind: 'attention', taskId: 'T1', attention: 'failure', reason: expect.stringContaining('The run hit its turn limit.') })]);
    expect(factory.github.prState(101).state).toBe('open');
    expect(factory.github.prWrites).toEqual([]);
  });

  test('a read of the old red head right after the fix run’s push waits for the new head’s checks, rather than asking the operator', async () => {
    const { factory, operator, tui } = await redAtGate();
    await started(factory, 4);
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    const redHead = factory.github.headOf(factory.github.pullRequests[0]!);
    // GitHub hasn't caught up with the push yet: its reads still give the old head.
    factory.github.reportHead(101, redHead);
    commit(factory, 'export const fixed = true;\n');
    const reads = factory.github.checkReads.length;

    factory.executor.report('R4', { type: 'runCompleted' });

    await vi.waitFor(() => expect(factory.github.checkReads.slice(reads).some(({ head }) => head === redHead)).toBe(true));
    await operator.send({ type: 'daemon.status' });
    expect(tui.state().attentionQueue).toEqual([]);
    expect(tui.state().tasks.T1).toMatchObject({ label: 'At merge gate' });
    expect(factory.executor.started).toHaveLength(4);

    // Caught up, the new head's own red checks ask the operator.
    factory.github.reportHead(101, null);
    factory.github.setChecks(101, 'red', [LINT]);
    factory.clock.advance(2 * MINUTE);
    const asked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(asked.attentionQueue).toEqual([expect.objectContaining({ attention: 'failure', reason: expect.stringContaining('still failing after its fix run: lint') })]);
  });

  test('green checks spend the fix run no longer, even when the merge they let through fails: a later red gets a fix run of its own', async () => {
    const { factory, operator, tui } = await redAtGate();
    await started(factory, 4);
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    commit(factory, 'export const fixed = true;\n');
    factory.github.failMerges('GitHub refused to merge acme/widgets#101 (HTTP 405: Base branch was modified.).');
    factory.executor.report('R4', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.gate?.checks === 'pending');
    factory.github.setChecks(101, 'green');
    factory.clock.advance(2 * MINUTE);
    await tui.until((state) => state.attentionQueue.some((item) => 'attention' in item && item.attention === 'github-write'));

    // CI re-run on the same head goes red; the operator answers the failed merge.
    factory.github.failMerges(null);
    factory.github.setChecks(101, 'red', [BUILD]);
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });

    const fix = await started(factory, 5);
    expect(fix.firstMessage).toContain('build (https://github.com/acme/widgets/actions/runs/7/job/1)');
    expect(tui.state().attentionQueue).toEqual([]);
  });
});
