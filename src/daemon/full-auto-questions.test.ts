// Seam 1: under full-auto (ADR 0014), through the client protocol, a run
// never puts a question to the operator. Its `AskUserQuestion` raises no
// attention request: the factory declines it, telling the run to pick the
// most reasonable answer and record it through `record_assumption`, and the
// run carries on. What it records is kept on the task as a judgement call,
// across a restart, and the PR body lists it under a judgement-calls
// heading. Under the operator policy questions reach the operator as before,
// and failures and `stage-blocked` still raise attention requests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Question } from '../lifecycle/lifecycle.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

// A factory with a subscription token for contained runs, and an operator attached.
async function attached(): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

const fullAuto: LaunchCommand = { type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: 'Add a logout button.', autonomy: 'L3', mergePolicy: 'unattended' };

const question: Question = {
  id: 'toolu_1',
  questions: [
    {
      question: 'Where should the logout button go?',
      header: 'Placement',
      options: [
        { label: 'Header', description: 'Top right, by the avatar.' },
        { label: 'Menu', description: 'In the account menu.' },
      ],
      multiSelect: false,
    },
  ],
};

// The run that started `n`th, once the executor has it.
async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

// Completes the implement run `implement` after a commit, then the review
// and PR body runs after it.
async function throughPrBody({ factory }: Factory, implement: number): Promise<void> {
  const workdir = factory.sandbox.workdirOf('T1');
  factory.git.editFile(workdir, 'src/logout.ts', 'export {};\n');
  factory.git.commitAll(workdir);
  factory.executor.report(`R${implement}`, { type: 'runCompleted' });
  await started(factory, implement + 1);
  factory.executor.report(`R${implement + 1}`, { type: 'runCompleted' });
  await started(factory, implement + 2);
  factory.executor.report(`R${implement + 2}`, { type: 'prBodyWritten', body: 'Adds a logout button.' });
  factory.executor.report(`R${implement + 2}`, { type: 'runCompleted' });
}

describe('under full-auto (unattended)', () => {
  test('a run’s question raises no attention request: the run is told to choose and record the answer it assumed, and carries on', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(fullAuto);
    const run = await started(factory, 1);
    // Its runs are given the tool they record their assumed answers with.
    expect(run).toMatchObject({ runId: 'R1', assumes: true });

    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });

    await vi.waitFor(() => expect(factory.executor.declined).toHaveLength(1));
    expect(factory.executor.declined[0]).toEqual({ runId: 'R1', questionId: 'toolu_1', message: expect.stringContaining('record_assumption') });
    expect(factory.executor.declined[0]!.message).toMatch(/most reasonable/);
    const state = await operator.send({ type: 'daemon.status' }).then(() => tui.state());
    expect(state.attentionQueue).toEqual([]);
    expect(state.runs.R1).toMatchObject({ status: 'active' });
    expect(state.tasks.T1).toMatchObject({ label: 'Running' });
  });

  test('the answer a run assumed is kept on the task across a restart, and the PR body lists it under a judgement-calls heading', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(fullAuto);
    await started(factory, 1);
    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });
    factory.executor.report('R1', {
      type: 'answerAssumed',
      question: 'Where should the logout button go?',
      answer: 'Header, by the avatar.',
      reason: 'The other account actions are there.',
    });
    const recorded = await tui.until((state) => (state.tasks.T1?.judgementCalls.length ?? 0) === 1);
    expect(recorded.tasks.T1!.judgementCalls).toEqual([
      { kind: 'assumed-answer', taskId: 'T1', question: 'Where should the logout button go?', answer: 'Header, by the avatar.', reason: 'The other account actions are there.' },
    ]);

    // A restart interrupts R1; R2 carries the implement stage on.
    await factory.restart();
    const after = watch(await factory.attach());
    const resumed = await after.until((state) => state.runs.R2?.status === 'active');
    expect(resumed.tasks.T1!.judgementCalls).toHaveLength(1);
    await throughPrBody({ ...launched, tui: after }, 2);

    await after.until((state) => !!state.tasks.T1?.pr);
    const body = factory.github.pullRequests[0]!.body;
    expect(body).toContain(
      '## Judgement calls\n\n- Assumed, asked “Where should the logout button go?”: Header, by the avatar. (The other account actions are there.)',
    );
  });

  test('a child of a full-auto root assumes too, and the answer it assumed is kept on the root', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(fullAuto);
    await started(factory, 1);
    const spawned = await factory.executor.delegate('R1', { type: 'spawnChild', toolUseId: 'toolu_spawn', goal: 'Survey sign-out.', await: false });
    expect(spawned).toMatchObject({ ok: true });
    const child = await started(factory, 2);
    expect(child).toMatchObject({ taskId: 'T2', child: true, assumes: true });

    factory.executor.report(child.runId, { type: 'attentionRaised', kind: 'question', question });
    await vi.waitFor(() => expect(factory.executor.declined).toEqual([expect.objectContaining({ runId: child.runId })]));
    factory.executor.report(child.runId, { type: 'answerAssumed', question: 'Which paths?', answer: 'The web ones.' });

    const recorded = await tui.until((state) => (state.tasks.T1?.judgementCalls.length ?? 0) === 1);
    expect(recorded.tasks.T1!.judgementCalls).toEqual([{ kind: 'assumed-answer', taskId: 'T2', question: 'Which paths?', answer: 'The web ones.', reason: null }]);
    expect(recorded.attentionQueue).toEqual([]);
  });

  test('a run that assumed no answers gets no judgement-calls section', async () => {
    const launched = await attached();
    const { factory, tui } = launched;
    await launched.operator.send(fullAuto);
    await started(factory, 1);
    await throughPrBody(launched, 1);

    await tui.until((state) => !!state.tasks.T1?.pr);
    expect(factory.github.pullRequests[0]!.body).not.toContain('Judgement calls');
  });

  test('failures and stage-blocked still raise attention requests', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(fullAuto);
    await started(factory, 1);
    factory.executor.report('R1', { type: 'runFailed', reason: 'The run hit its max turns (80) before it finished.' });
    await tui.until((state) => state.attentionQueue.length === 1);
    expect(tui.state().attentionQueue).toEqual([expect.objectContaining({ taskId: 'T1', attention: 'failure' })]);

    // Retried, the PR body run that ends without writing one is blocked.
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });
    await started(factory, 2);
    factory.git.editFile(factory.sandbox.workdirOf('T1'), 'src/logout.ts', 'export {};\n');
    factory.git.commitAll(factory.sandbox.workdirOf('T1'));
    factory.executor.report('R2', { type: 'runCompleted' });
    await started(factory, 3);
    factory.executor.report('R3', { type: 'runCompleted' });
    await started(factory, 4);
    factory.executor.report('R4', { type: 'runCompleted' });
    const blocked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(blocked.attentionQueue).toEqual([expect.objectContaining({ taskId: 'T1', attention: 'stage-blocked' })]);
  });
});

describe('at a stage capped at L2', () => {
  test('a full-auto root’s run there asks the operator, as at L2, and the next stage at L3 assumes again', async () => {
    const { factory, operator, tui } = await attached();
    mkdirSync(factory.paths.presetsDir, { recursive: true });
    const stages = '  - { id: build, kind: run, mode: AFK, skill: implement, args: "{{prompt}}", autonomy: L2 }\n  - { id: check, kind: run, mode: AFK, skill: code-review }\n';
    writeFileSync(join(factory.paths.presetsDir, 'capped.preset.yaml'), `stages:\n${stages}`);
    expect(await operator.send({ ...fullAuto, preset: 'capped' })).toEqual({ ok: true, value: { taskId: 'T1' } });
    expect(await started(factory, 1)).toMatchObject({ autonomy: 'L2', assumes: false });

    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });
    const asked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(asked.attentionQueue).toEqual([expect.objectContaining({ taskId: 'T1', attention: 'question' })]);
    expect(factory.executor.declined).toEqual([]);

    await operator.send({ type: 'answer', taskId: 'T1', answers: { 'Where should the logout button go?': 'Menu' } });
    factory.executor.report('R1', { type: 'runCompleted' });
    expect(await started(factory, 2)).toMatchObject({ autonomy: 'L3', assumes: true });
  });
});

describe('under the operator policy', () => {
  test('a run’s question still reaches the operator, and its runs assume no answers', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ ...fullAuto, mergePolicy: undefined });
    expect(await started(factory, 1)).toMatchObject({ assumes: false });

    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });

    const asked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(asked.attentionQueue).toEqual([expect.objectContaining({ taskId: 'T1', attention: 'question' })]);
    expect(asked.runs.R1).toMatchObject({ status: 'suspended' });
    expect(factory.executor.declined).toEqual([]);
    expect(await operator.send({ type: 'answer', taskId: 'T1', answers: { 'Where should the logout button go?': 'Menu' } })).toEqual({ ok: true });
    expect(factory.executor.answered).toEqual([{ runId: 'R1', questionId: 'toolu_1', answers: { 'Where should the logout button go?': 'Menu' } }]);
  });
});
