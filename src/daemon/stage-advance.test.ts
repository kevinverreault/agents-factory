// Seam 1: HITL → HITL stage boundaries. The agent may propose advancing; only
// the operator's confirm on the advance sheet moves the task to its next stage.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { relayHook } from '../hooks/relay.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const prompt = 'Grill me about the login flow.';

// A factory with T1 launched from `preset` (main-flow by default), in
// conversation at its first stage on R1. `presets` are user presets to write first.
async function grilling(
  preset?: string,
  presets: Record<string, string> = {},
): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched; printIssue(number: number): Promise<void> }> {
  const factory = await startTestFactory();
  factories.push(factory);
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  for (const [name, content] of Object.entries(presets)) writeFileSync(join(factory.paths.presetsDir, `${name}.preset.yaml`), content);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt, ...(preset && { preset }) });
  if (!launched.ok) throw new Error(launched.reason);
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  const { sessionId, cwd } = factory.executor.started[0]!;
  // A tool of the task's latest run prints an issue's URL, as `gh issue create` does.
  const printIssue = async (number: number) => {
    const before = Object.keys(tui.state().artifacts).length;
    const event = { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh issue create' } };
    await relayHook(JSON.stringify({ ...event, tool_response: `https://github.com/acme/widgets/issues/${number}\n` }), factory.paths);
    await tui.until((state) => Object.keys(state.artifacts).length > before);
  };
  return { factory, operator, tui, printIssue };
}

// A user preset of HITL stages, one per argument (YAML flow mapping fields).
const hitl = (...stages: string[]) => `stages:\n${stages.map((stage) => `  - { kind: run, mode: HITL, ${stage} }\n`).join('')}`;

describe('proposing and confirming an advance', () => {
  test('propose_advance shows a proposal on the run and changes nothing else', async () => {
    const { factory, tui } = await grilling();

    factory.executor.report('R1', { type: 'advanceProposed', reason: 'The login flow is settled.' });

    const proposed = await tui.until((state) => state.runs.R1?.proposal !== null);
    expect(proposed.runs.R1).toMatchObject({ status: 'active', proposal: { reason: 'The login flow is settled.' } });
    expect(proposed.tasks.T1).toMatchObject({ stage: 'grill', liveRunId: 'R1' });
    expect(factory.executor.started).toHaveLength(1);
    expect(factory.executor.stopped).toEqual([]);
  });

  test('confirming the advance ends the stage’s run completed and starts the next stage’s skill on the same session', async () => {
    const { factory, operator, tui } = await grilling();
    factory.executor.report('R1', { type: 'advanceProposed', reason: 'The login flow is settled.' });
    await tui.until((state) => state.runs.R1?.proposal !== null);

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });

    const advanced = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(advanced.tasks.T1).toMatchObject({ stage: 'spec', label: 'In conversation' });
    expect(advanced.runs.R1).toMatchObject({ status: 'ended', outcome: 'completed', stage: 'grill' });
    expect(advanced.runs.R2).toMatchObject({ status: 'active', stage: 'spec', turn: 'agent', proposal: null });
    expect(factory.executor.stopped).toEqual(['R1']);
    const [grill, spec] = factory.executor.started;
    expect(spec).toMatchObject({
      runId: 'R2',
      mode: 'HITL',
      sessionId: grill!.sessionId,
      resumesSession: true,
      cwd: grill!.cwd,
      firstMessage: '/factory:to-spec',
      model: 'claude-opus-5-5',
    });
  });

  test('the operator’s next message sets the proposal aside: they keep talking instead', async () => {
    const { factory, operator, tui } = await grilling();
    factory.executor.report('R1', { type: 'advanceProposed', reason: 'The login flow is settled.' });
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.proposal !== null && state.runs.R1?.turn === 'operator');

    await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Not yet: what about Safari?' });

    expect((await tui.until((state) => state.runs.R1?.proposal === null)).tasks.T1?.stage).toBe('grill');
  });
});

describe('exit conditions and args', () => {
  test('artifact:spec holds only once the spec stage has captured an issue, which then fills the tickets stage’s args', async () => {
    const { factory, operator, tui, printIssue } = await grilling();
    // Printed while grilling: an issue, but no spec.
    await printIssue(40);
    await operator.send({ type: 'advanceStage', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'spec’s exit, artifact:spec, doesn’t hold: T1 has no spec yet.',
    });
    expect(tui.state().tasks.T1).toMatchObject({ stage: 'spec', liveRunId: 'R2' });

    await printIssue(41);
    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });

    expect((await tui.until((state) => state.tasks.T1?.liveRunId === 'R3')).tasks.T1?.stage).toBe('tickets');
    expect(factory.executor.started.at(-1)).toMatchObject({ runId: 'R3', firstMessage: '/factory:to-tickets acme/widgets#41' });
  });

  test('artifact:tickets holds only once the tickets stage has captured an issue, and every ticket fills the next stage’s args', async () => {
    const { factory, operator, tui, printIssue } = await grilling('slicing', {
      slicing: hitl('id: tickets, skill: to-tickets, args: "{{prompt}}", exit: "artifact:tickets"', 'id: triage, skill: triage, args: "{{artifacts.tickets}}"'),
    });

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'tickets’s exit, artifact:tickets, doesn’t hold: T1 has no tickets yet.',
    });
    await printIssue(42);
    await printIssue(43);
    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.stage === 'triage');
    expect(factory.executor.started.at(-1)).toMatchObject({ firstMessage: '/factory:triage acme/widgets#42 acme/widgets#43' });
  });

  test('a later stage’s {{prompt}} is the launch prompt, and a fresh-context stage starts a new session', async () => {
    const { factory, operator, tui } = await grilling('two-takes', {
      'two-takes': hitl('id: first, skill: grill-me, args: "{{prompt}}"', 'id: second, skill: grill-with-docs, args: "again: {{prompt}}", context: fresh'),
    });

    await operator.send({ type: 'advanceStage', taskId: 'T1' });

    const { tasks } = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    const [first, second] = factory.executor.started;
    expect(second).toMatchObject({ resumesSession: false, firstMessage: `/factory:grill-with-docs again: ${prompt}` });
    expect(second!.sessionId).not.toBe(first!.sessionId);
    expect(tasks.T1?.sessionId).toBe(second!.sessionId);
  });

  test('main-flow’s tickets stage leads to an AFK stage: that is the handoff’s, not the advance sheet’s', async () => {
    const { operator, tui, printIssue } = await grilling();
    await operator.send({ type: 'advanceStage', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.stage === 'spec');
    await printIssue(41);
    await operator.send({ type: 'advanceStage', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.stage === 'tickets');
    await printIssue(42);

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'The next stage, implement, is AFK: hand T1 off to start it.',
    });
  });
});

describe('skipping optional stages', () => {
  const lean = hitl(
    'id: grill, skill: grill-with-docs, args: "{{prompt}}"',
    'id: glossary, skill: domain-modeling, optional: true',
    'id: spec, skill: to-spec, optional: true, exit: "artifact:spec"',
    'id: tickets, skill: to-tickets, args: "{{artifacts.spec}}"',
  );

  test('the advance sheet can skip optional stages, and only those', async () => {
    const { factory, operator, tui } = await grilling('lean', { lean });

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1', skip: ['tickets'] })).toEqual({
      ok: false,
      reason: 'tickets isn’t a stage between grill and glossary.',
    });
    expect(await operator.send({ type: 'advanceStage', taskId: 'T1', skip: ['glossary', 'spec', 'tickets'] })).toEqual({
      ok: false,
      reason: 'tickets isn’t optional, so it can’t be skipped.',
    });
    expect(await operator.send({ type: 'advanceStage', taskId: 'T1', skip: ['glossary'] })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.stage === 'spec');
    expect(factory.executor.started.at(-1)).toMatchObject({ firstMessage: '/factory:to-spec' });
  });

  test('a next stage whose args can’t be filled raises a stage-blocked attention request naming what’s missing, instead of starting', async () => {
    const { factory, operator, tui } = await grilling('lean', { lean });

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1', skip: ['glossary', 'spec'] })).toEqual({ ok: true });

    const blocked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    // The task stays at the stage it was leaving, so the advance can be retried.
    expect(blocked.tasks.T1).toMatchObject({ stage: 'grill', liveRunId: null });
    expect(blocked.runs.R1).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(blocked.attentionQueue).toEqual([
      {
        kind: 'attention',
        taskId: 'T1',
        repo: 'acme/widgets',
        requestId: 'A1',
        attention: 'stage-blocked',
        holdsRun: false,
        reason: 'tickets can’t start: its args need {{artifacts.spec}}, and T1 has no spec.',
        question: null,
        permission: null,
      },
    ]);
    expect(factory.executor.started).toHaveLength(1);

    // Once answered, the operator advances again without skipping the spec.
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });
    expect(await operator.send({ type: 'advanceStage', taskId: 'T1', skip: ['glossary'] })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.stage === 'spec' && state.tasks.T1.liveRunId === 'R2');
    expect(factory.executor.started.at(-1)).toMatchObject({ resumesSession: true, firstMessage: '/factory:to-spec' });
  });
});

describe('model tiers', () => {
  test('each stage runs at its own tier, unless the operator picked one at launch', async () => {
    const { factory, operator, tui } = await grilling('tiers', {
      tiers: hitl('id: first, skill: grill-me, args: "{{prompt}}", model: opus', 'id: second, skill: to-spec, model: haiku', 'id: third, skill: to-tickets'),
    });
    await operator.send({ type: 'advanceStage', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.stage === 'second');
    await operator.send({ type: 'advanceStage', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.stage === 'third');
    // The third stage names no tier: it keeps the task's.
    expect(factory.executor.started.map((run) => run.model)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5']);

    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'tiers', prompt, tier: 'sonnet' });
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R4');
    await operator.send({ type: 'advanceStage', taskId: 'T2' });
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R5');
    expect(factory.executor.started.slice(3).map((run) => run.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5']);
  });
});

describe('where an advance can and can’t go', () => {
  test('advancing past the last stage ends its run completed and puts the root task in review', async () => {
    const { factory, operator, tui } = await grilling('setup');

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });

    const reviewed = await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(reviewed.runs.R1).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(reviewed.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
    expect(factory.executor.stopped).toEqual(['R1']);
  });

  test('a parked conversation advances too, its next stage resuming the session', async () => {
    const { factory, operator, tui } = await grilling();
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.turn === 'operator');
    factory.clock.advance(30 * 60_000);
    await tui.until((state) => state.runs.R1?.outcome === 'parked');

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(factory.executor.started.at(-1)).toMatchObject({ resumesSession: true, firstMessage: '/factory:to-spec' });
  });

  test('only a HITL task in conversation or ready for you advances, and only along a preset', async () => {
    const { operator, tui } = await grilling();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Implement the store', mode: 'AFK', submit: true });
    await operator.send({ type: 'cancel', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.label === 'Cancelled');

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'Only a HITL task in conversation or ready for you advances its stage (T1 is Cancelled).',
    });
    expect(await operator.send({ type: 'advanceStage', taskId: 'T2' })).toEqual({ ok: false, reason: 'T2 follows no workflow preset.' });
    expect(await operator.send({ type: 'advanceStage', taskId: 'T9' })).toEqual({ ok: false, reason: 'There is no task T9.' });
  });
});
