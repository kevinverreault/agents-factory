// Seam 1: quick launch (`n`). One prompt starts the `quick` preset's grill,
// which asks at most three questions and ends on the handoff sheet, at L1 by
// default. Expanding it into a full conversation stops that; confirming the
// handoff runs implement as a single AFK run, then the review.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { Question } from '../lifecycle/lifecycle.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const prompt = 'Add a --json flag to the status command.';

// A factory with T1 quick-launched on R1, the agent mid-turn on its opening.
async function quickLaunched(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'quick', prompt, quick: true });
  if (!launched.ok) throw new Error(launched.reason);
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  return { factory, operator, tui };
}

const briefRequest = (factory: TestFactory) => factory.executor.sent.filter(({ text }) => text.includes('handoff brief'));

const brief = {
  goal: 'The status command prints JSON with --json.',
  decided: ['Same fields as the table.'],
  doneWhen: ['`status --json` parses with jq.'],
  outOfScope: [],
  links: [],
};

function asked(id: string, ...texts: string[]): Question {
  return {
    id,
    questions: texts.map((question) => ({ question, header: 'Q', options: [{ label: 'Yes', description: '' }], multiSelect: false })),
  };
}

describe('quick launch', () => {
  test('the grill starts on the quick-grill skill, and its turn ending opens the handoff sheet to implement at L1', async () => {
    const { factory, tui } = await quickLaunched();
    expect(tui.state().tasks.T1).toMatchObject({ mode: 'HITL', stage: 'grill', quick: { questions: 0 }, handoff: null });
    expect(factory.executor.started[0]?.firstMessage).toContain('/factory:quick-grill');

    factory.executor.report('R1', { type: 'turnEnded' });

    const opened = await tui.until((state) => state.tasks.T1?.handoff !== null);
    expect(opened.tasks.T1?.handoff).toMatchObject({ brief: null, stage: 'implement', autonomy: 'L1' });
    // Once its sheet opened, the quick launch is over: backing out keeps the conversation going.
    expect(opened.tasks.T1?.quick).toBeNull();
    await vi.waitFor(() => expect(briefRequest(factory)).toMatchObject([{ runId: 'R1' }]));
  });

  test('it asks at most three questions: a card past them is cut to what is left, and the third answer is read before the sheet opens', async () => {
    const { factory, operator, tui } = await quickLaunched();
    factory.executor.report('R1', { type: 'questionAsked', question: asked('toolu_1', 'Same fields?', 'Pretty-print?') });
    await tui.until((state) => state.runs.R1?.question !== null);
    const first = await operator.send({ type: 'answerQuestion', taskId: 'T1', questionId: 'toolu_1', answers: { 'Same fields?': 'Yes', 'Pretty-print?': 'Yes' } });
    expect(first).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.quick?.questions === 2);

    factory.executor.report('R1', { type: 'questionAsked', question: asked('toolu_2', 'Exit code on error?', 'Schema file?') });
    const cut = await tui.until((state) => state.runs.R1?.question !== null);
    expect(cut.runs.R1?.question?.questions.map(({ question }) => question)).toEqual(['Exit code on error?']);
    await operator.send({ type: 'answerQuestion', taskId: 'T1', questionId: 'toolu_2', answers: { 'Exit code on error?': 'Yes' } });
    await tui.until((state) => state.tasks.T1?.quick?.questions === 3);

    // The agent reads the third answer on its turn: the sheet waits for that turn to end.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tui.state().tasks.T1?.handoff).toBeNull();
    factory.executor.report('R1', { type: 'turnEnded' });

    const opened = await tui.until((state) => state.tasks.T1?.handoff !== null);
    expect(opened.tasks.T1).toMatchObject({ quick: null, handoff: { stage: 'implement', autonomy: 'L1' } });
    expect(factory.executor.answered.map(({ questionId }) => questionId)).toEqual(['toolu_1', 'toolu_2']);
    expect(factory.executor.interrupted).toEqual([]);
    await vi.waitFor(() => expect(briefRequest(factory)).toMatchObject([{ runId: 'R1' }]));
  });

  test('a question past the three opens the sheet instead of its card, interrupting the agent', async () => {
    const { factory, operator, tui } = await quickLaunched();
    factory.executor.report('R1', { type: 'questionAsked', question: asked('toolu_1', 'Same fields?', 'Pretty-print?', 'Exit code on error?') });
    await tui.until((state) => state.runs.R1?.question !== null);
    const answers = { 'Same fields?': 'Yes', 'Pretty-print?': 'Yes', 'Exit code on error?': 'Yes' };
    await operator.send({ type: 'answerQuestion', taskId: 'T1', questionId: 'toolu_1', answers });

    factory.executor.report('R1', { type: 'questionAsked', question: asked('toolu_2', 'Schema file?') });

    const opened = await tui.until((state) => state.tasks.T1?.handoff !== null);
    expect(opened.runs.R1?.question).toBeNull();
    expect(factory.executor.interrupted).toEqual(['R1']);
    factory.executor.report('R1', { type: 'turnEnded' });
    await vi.waitFor(() => expect(briefRequest(factory)).toMatchObject([{ runId: 'R1' }]));
  });

  test('reopened after a restart, it opens the sheet only once a turn of the grill ends', async () => {
    const { factory, tui } = await quickLaunched();
    factory.executor.report('R1', { type: 'questionAsked', question: asked('toolu_1', 'Same fields?') });
    await tui.until((state) => state.runs.R1?.question !== null);

    await factory.restart();
    const operator = await factory.attach();
    const after = watch(operator);
    await after.until((state) => state.runs.R1?.status === 'ended');
    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({ ok: true });
    await after.until((state) => state.runs.R2?.status === 'active');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(after.state().tasks.T1).toMatchObject({ quick: { questions: 0 }, handoff: null });
    factory.executor.report('R2', { type: 'turnEnded' });
    await after.until((state) => state.tasks.T1?.handoff !== null);
  });

  test('expanded into a full conversation, it is a grill like any other: its turn ending opens no sheet', async () => {
    const { factory, operator, tui } = await quickLaunched();

    expect(await operator.send({ type: 'expandQuickLaunch', taskId: 'T1' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.quick === null);
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.turn === 'operator');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tui.state().tasks.T1).toMatchObject({ mode: 'HITL', handoff: null, liveRunId: 'R1' });
    expect(briefRequest(factory)).toEqual([]);
    expect(await operator.send({ type: 'expandQuickLaunch', taskId: 'T1' })).toEqual({ ok: false, reason: 'T1 is no quick launch, or is one no longer.' });
  });

  test('a quick launch of a preset that starts AFK is refused', async () => {
    const factory = await startTestFactory();
    factories.push(factory);
    await factory.registerRepo();
    const operator = await factory.attach();

    const refused = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt, quick: true });

    expect(refused).toEqual({ ok: false, reason: 'A quick launch grills you first, but implement starts at an AFK stage (implement).' });
    expect(factory.executor.started).toEqual([]);
  });

  test('the confirmed handoff runs implement as a single AFK run on the brief, then the review', async () => {
    const { factory, operator, tui } = await quickLaunched();
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.tasks.T1?.handoff !== null);
    await vi.waitFor(() => expect(briefRequest(factory)).toHaveLength(1));
    factory.executor.report('R1', { type: 'briefWritten', brief });
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.tasks.T1?.handoff?.brief !== null);

    const handedOff = await operator.send({ type: 'handoff', taskId: 'T1', brief, continueAs: 'resume', autonomy: 'L1', tier: 'sonnet', maxTurns: 300 });
    expect(handedOff).toEqual({ ok: true });

    const implementing = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(implementing.tasks.T1).toMatchObject({ mode: 'AFK', autonomy: 'L1', stage: 'implement', loop: null });
    expect(implementing.runs.R2).toMatchObject({ mode: 'AFK', stage: 'implement', ticket: null });
    const opening = factory.executor.started[1]!.firstMessage!;
    expect(opening).toContain('/factory:implement');
    expect(opening).toContain(brief.goal);

    factory.executor.report('R2', { type: 'runCompleted' });

    const reviewing = await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    expect(reviewing.tasks.T1).toMatchObject({ mode: 'AFK', stage: 'review' });
    expect(factory.executor.started[2]!.firstMessage).toContain('/factory:code-review');
  });
});
