// Seam 1: full-auto (ADR 0014), through the client protocol. Under the
// `unattended` merge policy, an L3 root past its last stage waits at its
// merge gate instead of going In review. The PR poll reads the checks on its
// PR's head, every 2 minutes while it waits: pending waits, and once they are
// green, or two reads of the same head found none, the factory marks the draft ready and merges
// it with a merge commit, each GitHub call with a token of its own. The root
// then follows the merged-PR path: its ticket closes, and it is Done and
// cleaned up. A red check is left waiting. Under `operator`, nothing changes.
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { openStore } from '../store/store.ts';
import { recoveryReport } from '../testing/recovery-report.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const clone = resolve('/clones/widgets');
const MINUTE = 60_000;
const TICKET = 'acme/widgets#39';

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

// A factory with a subscription token for contained runs, and the ticket #39 on GitHub.
async function attached(): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  factory.github.addIssue(TICKET, { labels: ['ready-for-agent'] });
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

// One implement run on a brief, at L3 under full-auto.
const fullAuto: LaunchCommand = { type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: 'Add a logout button.', autonomy: 'L3', mergePolicy: 'unattended' };

// The run that started `n`th, once the executor has it.
async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

// Works the task's implement, review and PR body runs, from the run `first`
// on: the implement run commits in the task's container.
async function throughOpenPr({ factory }: Factory, taskId = 'T1', first = 1): Promise<void> {
  await started(factory, first);
  const workdir = factory.sandbox.workdirOf(taskId);
  factory.git.editFile(workdir, 'src/logout.ts', 'export {};\n');
  factory.git.commitAll(workdir);
  factory.executor.report(`R${first}`, { type: 'runCompleted' });
  await started(factory, first + 1);
  factory.executor.report(`R${first + 1}`, { type: 'runCompleted' });
  await started(factory, first + 2);
  factory.executor.report(`R${first + 2}`, { type: 'prBodyWritten', body: 'Adds a logout button.' });
  factory.executor.report(`R${first + 2}`, { type: 'runCompleted' });
}

// A repo that runs no checks: the gate's first read found none on its head,
// and the next, 2 minutes later, finds none again, which lets it through.
async function noChecksTwice({ factory, tui }: Factory, taskId = 'T1'): Promise<void> {
  await tui.until((state) => state.tasks[taskId]?.gate?.checks === 'none');
  factory.clock.advance(2 * MINUTE);
}

describe('under full-auto (unattended)', () => {
  test('a single run on a brief waits at its gate while its checks are pending, and is marked ready and merged with a merge commit once they are green', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    factory.github.runChecks('acme/widgets', 'pending');

    expect(await operator.send(fullAuto)).toEqual({ ok: true, value: { taskId: 'T1' } });
    await throughOpenPr(launched);

    const waiting = await tui.until((state) => state.tasks.T1?.gate?.checks === 'pending');
    expect(waiting.tasks.T1).toMatchObject({ label: 'At merge gate', mergePolicy: 'unattended', gate: { checks: 'pending', step: null, problem: null }, pr: { number: 101, draft: true } });
    // The factory's to merge: nothing waits on the operator.
    expect(waiting.attentionQueue).toEqual([]);
    expect(factory.github.prWrites).toEqual([]);

    factory.github.setChecks(101, 'green');
    // Read again at the faster pace while it waits at the gate.
    factory.clock.advance(2 * MINUTE);

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(done.attentionQueue).toEqual([]);
    expect(factory.github.prState(101).state).toBe('merged');
    const branch = done.tasks.T1!.branch!;
    expect(factory.git.originTip(clone, 'main')).not.toBeNull();
    expect(factory.git.originTip(clone, branch)).toBeNull();
    expect(factory.github.prWrites).toEqual([
      { action: 'ready', repo: 'acme/widgets', number: 101, token: expect.objectContaining({ repo: 'acme/widgets', permissions: { pull_requests: 'write', metadata: 'read' } }) },
      {
        action: 'merge',
        repo: 'acme/widgets',
        number: 101,
        method: 'merge',
        token: expect.objectContaining({ repo: 'acme/widgets', permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }),
      },
    ]);
    // Each read of the checks has its own token, narrowed to them.
    expect(factory.github.checkReads.length).toBeGreaterThanOrEqual(2);
    for (const read of factory.github.checkReads) {
      expect(read).toMatchObject({ repo: 'acme/widgets', token: { repo: 'acme/widgets', permissions: { checks: 'read', statuses: 'read', metadata: 'read' } } });
    }
  });

  test('a repo with no checks merges once a second read of the same head finds none again, as CI may not have registered its checks yet at the first', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(fullAuto);

    await throughOpenPr(launched);

    const first = await tui.until((state) => state.tasks.T1?.gate?.checks === 'none');
    expect(first.tasks.T1).toMatchObject({ label: 'At merge gate', gate: { checks: 'none', step: null } });
    expect(factory.github.prWrites).toEqual([]);
    factory.clock.advance(2 * MINUTE);

    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(factory.github.prState(101).state).toBe('merged');
    expect(factory.github.prWrites.map(({ action }) => action)).toEqual(['ready', 'merge']);
  });

  test('a regular PR, where GitHub offers no drafts, is merged without marking it ready', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    factory.github.offerNoDrafts('acme/widgets');
    await operator.send(fullAuto);

    await throughOpenPr(launched);
    await noChecksTwice(launched);

    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(factory.github.prWrites.map(({ action }) => action)).toEqual(['merge']);
  });

  test('a red check is left waiting at the gate, unmerged', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    factory.github.runChecks('acme/widgets', 'red');
    await operator.send(fullAuto);

    await throughOpenPr(launched);

    const red = await tui.until((state) => state.tasks.T1?.gate?.checks === 'red');
    expect(red.tasks.T1?.label).toBe('At merge gate');
    factory.clock.advance(2 * MINUTE);
    await operator.send({ type: 'daemon.status' });
    expect(factory.github.prState(101).state).toBe('open');
    expect(factory.github.prWrites).toEqual([]);
  });

  test('a ticket task’s merge closes its ticket, and it is Done', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;

    expect(await operator.send({ ...fullAuto, prompt: '', issues: ['#39'] })).toEqual({ ok: true, value: { taskId: 'T1' } });
    await throughOpenPr(launched);
    await noChecksTwice(launched);

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.resolving === null && state.tasks.T1.cleanup === null);
    expect(done.tasks.T1).toMatchObject({ kind: 'ticket', ticket: TICKET, mergePolicy: 'unattended' });
    expect(factory.github.prState(101).state).toBe('merged');
    expect(factory.github.issueState(TICKET).open).toBe(false);
  });

  test('a merge that fails raises a github-write request, and answering it tries again', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    factory.github.failMerges('GitHub refused to merge acme/widgets#101 (HTTP 405: Base branch was modified.).');
    await operator.send(fullAuto);
    await throughOpenPr(launched);
    await noChecksTwice(launched);

    const asked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(asked.attentionQueue).toEqual([
      expect.objectContaining({ kind: 'attention', taskId: 'T1', attention: 'github-write', reason: 'The factory couldn’t merge T1’s PR #101 on GitHub as its App: GitHub refused to merge acme/widgets#101 (HTTP 405: Base branch was modified.). Fix it, then answer to try again.' }),
    ]);
    expect(asked.tasks.T1).toMatchObject({ label: 'At merge gate', gate: { step: null, problem: expect.any(String) } });
    // Polled meanwhile, it isn't merged behind the operator's back, and still says why it failed.
    factory.github.failMerges(null);
    const reads = factory.github.checkReads.length;
    factory.clock.advance(2 * MINUTE);
    await vi.waitFor(() => expect(factory.github.checkReads.length).toBeGreaterThan(reads));
    await operator.send({ type: 'daemon.status' });
    expect(factory.github.prState(101).state).toBe('open');
    expect(tui.state().tasks.T1?.gate).toMatchObject({ step: null, problem: expect.stringMatching(/^The factory couldn’t merge T1’s PR #101/) });

    // Answered, the gate is read afresh, and finds no checks twice again before it merges.
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.gate?.checks === 'none' && state.tasks.T1.gate.problem === null);
    await noChecksTwice(launched);

    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(factory.github.prWrites.map(({ action }) => action)).toEqual(['ready', 'merge']);
  });
});

describe('the merge policy at launch and handoff', () => {
  test('full-auto is refused below L3, semi-auto isn’t offered yet, and a task starting HITL picks it at its handoff', async () => {
    const { operator, tui } = await attached();

    expect(await operator.send({ ...fullAuto, autonomy: 'L2' })).toEqual({
      ok: false,
      reason: 'Full-auto (unattended) merges the task’s PR, which the factory does only at L3: pick L3, or the operator policy.',
    });
    expect(await operator.send({ ...fullAuto, mergePolicy: 'judged' })).toMatchObject({ ok: false, reason: expect.stringMatching(/^Semi-auto \(judged\) isn’t available yet/) });
    expect(await operator.send({ ...fullAuto, mergePolicy: 'yolo' as never })).toEqual({ ok: false, reason: 'yolo is not a merge policy (operator, judged or unattended).' });
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me.', autonomy: 'L3', mergePolicy: 'unattended' })).toEqual({
      ok: false,
      reason: 'A task starting at a HITL stage picks its merge policy at its handoff.',
    });
    expect(tui.state().tasks).toEqual({});
  });

  test('a quick launch handed off at L3 under full-auto freezes it, and its PR merges', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'quick', prompt: 'Add a logout button.', quick: true });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.tasks.T1?.handoff !== null);
    factory.executor.report('R1', { type: 'briefWritten', brief: { goal: 'Add a logout button.', decided: [], doneWhen: [], outOfScope: [], links: [] } });
    factory.executor.report('R1', { type: 'turnEnded' });
    const { brief, tier, maxTurns, mergePolicy } = (await tui.until((state) => !!state.tasks.T1?.handoff?.brief)).tasks.T1!.handoff!;
    expect(mergePolicy).toBe('operator');
    const confirm = { type: 'handoff', taskId: 'T1', brief: brief!, continueAs: 'resume', autonomy: 'L3', tier, maxTurns } as const;

    expect(await operator.send({ ...confirm, autonomy: 'L2', mergePolicy: 'unattended' })).toMatchObject({ ok: false, reason: expect.stringContaining('only at L3') });
    expect(await operator.send({ ...confirm, mergePolicy: 'unattended' })).toEqual({ ok: true });
    expect(tui.state().tasks.T1).toMatchObject({ mode: 'AFK', autonomy: 'L3', mergePolicy: 'unattended' });

    await throughOpenPr(launched, 'T1', 2);
    await noChecksTwice(launched);
    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(factory.github.prState(101).state).toBe('merged');
  });
});

describe('under the operator policy', () => {
  test('an L3 task goes In review with its PR, reads no checks and merges nothing', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send({ ...fullAuto, mergePolicy: undefined });

    await throughOpenPr(launched);

    const reviewing = await tui.until((state) => state.tasks.T1?.label === 'In review' && state.tasks.T1.pr !== null);
    expect(reviewing.tasks.T1).toMatchObject({ mergePolicy: 'operator', gate: null });
    expect(reviewing.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
    factory.clock.advance(15 * MINUTE);
    await operator.send({ type: 'daemon.status' });
    expect(factory.github.checkReads).toEqual([]);
    expect(factory.github.prWrites).toEqual([]);
  });
});

// A factory merge is journaled as an intent before its first GitHub step
// (ADR 0003, ADR 0014): the next daemon finishes it, or finds it done, by
// reading the PR, and one that took no step on GitHub is rolled back to
// wait at its gate.
describe('a crash while merging', () => {
  // T1 at its gate with green checks, the daemon crashing at its call of `method` on GitHub, and a new one started.
  // `meanwhile` happens while it is down.
  async function crashingAt(
    method: 'markReady' | 'mergePr',
    when: 'before' | 'after',
    meanwhile = (_: TestFactory) => {},
    { drafts = true } = {},
  ): Promise<{ factory: TestFactory; tui: Watched }> {
    const launched = await attached();
    const { factory, operator } = launched;
    factory.github.runChecks('acme/widgets', 'green');
    if (!drafts) factory.github.offerNoDrafts('acme/widgets');
    const crashed = factory.crashAt('github', method, when);
    await operator.send(fullAuto);
    await throughOpenPr(launched);
    await crashed;
    await factory.crash();
    meanwhile(factory);
    await factory.startDaemon();
    return { factory, tui: watch(await factory.attach()) };
  }

  test.each([
    ['after', 'markReady'],
    ['before', 'mergePr'],
  ] as const)('%s %s, the merge is finished on restart: the PR is merged once and the task is Done', async (when, method) => {
    const { factory, tui } = await crashingAt(method, when);

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(factory.github.prState(101).state).toBe('merged');
    expect(factory.github.prWrites.map(({ action }) => action)).toEqual(['ready', 'merge']);
    expect(recoveryReport(done)?.recovery?.replayed).toEqual([{ taskId: 'T1', verb: 'merge', outcome: 'finished' }]);
    expect(recoveryReport(done)?.reason).toContain('T1’s merge');
  });

  test('after GitHub merged the PR, the restart finds it merged and makes no second merge call', async () => {
    const { factory, tui } = await crashingAt('mergePr', 'after');

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(factory.github.mergeCalls).toEqual(['acme/widgets#101']);
    expect(factory.github.prWrites.map(({ action }) => action)).toEqual(['ready', 'merge']);
    expect(recoveryReport(done)?.recovery?.replayed).toEqual([{ taskId: 'T1', verb: 'merge', outcome: 'finished' }]);
  });

  test('before any GitHub step, the task is left waiting at its gate, and merges on the next green poll', async () => {
    // A new commit's checks started meanwhile.
    const { factory, tui } = await crashingAt('markReady', 'before', (factory) => factory.github.setChecks(101, 'pending'));

    const back = await tui.until((state) => !!recoveryReport(state) && state.tasks.T1?.gate?.checks === 'pending');
    expect(recoveryReport(back)?.recovery?.replayed).toEqual([{ taskId: 'T1', verb: 'merge', outcome: 'rolled back' }]);
    expect(back.tasks.T1).toMatchObject({ label: 'At merge gate', pr: { draft: true }, gate: { step: null } });
    expect(factory.github.prWrites).toEqual([]);

    factory.github.setChecks(101, 'green');
    factory.clock.advance(2 * MINUTE);
    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(factory.github.prWrites.map(({ action }) => action)).toEqual(['ready', 'merge']);
  });

  test('before merging a regular PR, where the merge is the first GitHub step, the task is left waiting at its gate', async () => {
    const { factory, tui } = await crashingAt('mergePr', 'before', (factory) => factory.github.setChecks(101, 'pending'), { drafts: false });

    const back = await tui.until((state) => !!recoveryReport(state) && state.tasks.T1?.gate?.checks === 'pending');
    expect(recoveryReport(back)?.recovery?.replayed).toEqual([{ taskId: 'T1', verb: 'merge', outcome: 'rolled back' }]);
    expect(back.tasks.T1).toMatchObject({ label: 'At merge gate', gate: { step: null } });
    expect(factory.github.mergeCalls).toEqual([]);

    factory.github.setChecks(101, 'green');
    factory.clock.advance(2 * MINUTE);
    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(factory.github.prWrites.map(({ action }) => action)).toEqual(['merge']);
  });

  test('one GitHub refuses to finish on restart is resumed: its github-write request asks the operator, and the PR stays unmerged', async () => {
    const { factory, tui } = await crashingAt('mergePr', 'before', (factory) =>
      factory.github.failMerges('GitHub refused to merge acme/widgets#101 (HTTP 405: Base branch was modified.).'),
    );

    const asked = await tui.until((state) => !!recoveryReport(state) && state.attentionQueue.some((item) => item.kind === 'attention' && item.attention === 'github-write'));
    expect(recoveryReport(asked)?.recovery?.replayed).toEqual([{ taskId: 'T1', verb: 'merge', outcome: 'resumed' }]);
    expect(asked.tasks.T1).toMatchObject({ label: 'At merge gate', pr: { draft: false }, gate: { step: null, problem: expect.stringMatching(/^The factory couldn’t merge T1’s PR #101/) } });
    expect(factory.github.prState(101).state).toBe('open');
  });

  test('a store from before merges were journaled, its gate’s step left with no intent, is replayed too, with no second merge call', async () => {
    const { factory, tui } = await crashingAt('mergePr', 'after', (factory) => {
      const store = openStore(factory.paths.storePath);
      const saved = store.loadLifecycle()!;
      expect(saved.tasks.T1?.gate?.step).toBe('merge');
      saved.intents = {};
      store.saveLifecycle(saved);
      store.close();
    });

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(factory.github.mergeCalls).toEqual(['acme/widgets#101']);
    expect(recoveryReport(done)?.recovery?.replayed).toEqual([{ taskId: 'T1', verb: 'merge', outcome: 'finished' }]);
  });
});
