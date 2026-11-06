// Seam 1: the wayfinder preset's work loop. Once the chart stage made its
// map, the factory reads the map's frontier from GitHub, shows it under the
// task in Ready for you, and runs each ticket the operator picks (or the
// first) in a fresh HITL session, until the map has no open children. Then
// the operator chooses whether to continue to spec, jump to tickets, or end.
import { afterEach, describe, expect, test } from 'vitest';
import { relayHook } from '../hooks/relay.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const MAP = 'acme/widgets#30';

// A factory with T1 launched from wayfinder, charting on R1, and the map
// acme/widgets#30 on GitHub with the tickets #31, #32 (blocked by #31) and
// #33 under it.
async function charting(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched; printIssue(number: number): Promise<void> }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const { github } = factory;
  github.addIssue(MAP, { title: 'Billing overhaul', labels: ['wayfinder:map'] });
  github.addIssue('acme/widgets#31', { parent: MAP, title: 'Which payment provider?', labels: ['wayfinder:grilling'] });
  github.addIssue('acme/widgets#32', { parent: MAP, title: 'How do refunds flow?', labels: ['wayfinder:grilling'], blockedBy: ['acme/widgets#31'] });
  github.addIssue('acme/widgets#33', { parent: MAP, title: 'Invoice layout', labels: ['wayfinder:prototype'] });
  const operator = await factory.attach();
  const tui = watch(operator);
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'wayfinder', prompt: 'Overhaul billing.' });
  if (!launched.ok) throw new Error(launched.reason);
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  const printIssue = async (number: number) => {
    const { sessionId, cwd } = factory.executor.started.at(-1)!;
    const before = Object.keys(tui.state().artifacts).length;
    const event = { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh issue create' } };
    await relayHook(JSON.stringify({ ...event, tool_response: `https://github.com/acme/widgets/issues/${number}\n` }), factory.paths);
    await tui.until((state) => Object.keys(state.artifacts).length > before);
  };
  return { factory, operator, tui, printIssue };
}

// Charted: the map captured and the chart stage advanced from, the work
// loop showing its frontier in Ready for you.
async function working() {
  const charted = await charting();
  await charted.printIssue(30);
  const advanced = await charted.operator.send({ type: 'advanceStage', taskId: 'T1' });
  if (!advanced.ok) throw new Error(advanced.reason);
  await charted.tui.until((state) => !!state.tasks.T1?.loop?.frontier);
  return charted;
}

describe('the frontier', () => {
  test('appears under the task in Ready for you once the chart stage made the map', async () => {
    const { factory, tui } = await working();

    const state = tui.state();
    expect(state.runs.R1).toMatchObject({ status: 'ended', outcome: 'completed', stage: 'chart' });
    expect(state.tasks.T1).toMatchObject({ stage: 'work', label: 'Ready for you', liveRunId: null });
    // Open and unblocked, in sub-issue order.
    expect(state.tasks.T1!.loop!.frontier).toEqual([
      { ref: 'acme/widgets#31', title: 'Which payment provider?' },
      { ref: 'acme/widgets#33', title: 'Invoice layout' },
    ]);
    expect(state.attentionQueue).toEqual([{ kind: 'ready', taskId: 'T1' }]);
    expect(factory.executor.started).toHaveLength(1);
  });

  test('re-reads the map once the operator finishes a ticket: closing it on GitHub opens what it blocked', async () => {
    const { factory, operator, tui } = await working();
    await operator.send({ type: 'open', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');

    // The agent resolved #31 and closed it, as the wayfinder skill does.
    factory.github.close('acme/widgets#31');
    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });

    const reread = await tui.until((state) => state.tasks.T1?.loop?.frontier?.[0]?.ref === 'acme/widgets#32');
    expect(reread.runs.R2).toMatchObject({ status: 'ended', outcome: 'completed', stage: 'work' });
    expect(reread.tasks.T1).toMatchObject({ stage: 'work', label: 'Ready for you', liveRunId: null });
    expect(reread.tasks.T1!.loop!.frontier!.map(({ ref }) => ref)).toEqual(['acme/widgets#32', 'acme/widgets#33']);
    expect(factory.executor.stopped).toEqual(['R1', 'R2']);
  });

  test('a map whose every open ticket is blocked asks the operator, and reads it again once answered', async () => {
    const { factory, operator, tui, printIssue } = await charting();
    factory.github.addIssue('acme/widgets#39');
    for (const ref of ['acme/widgets#31', 'acme/widgets#33']) factory.github.block(ref, 'acme/widgets#39');
    await printIssue(30);
    await operator.send({ type: 'advanceStage', taskId: 'T1' });

    const stalled = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(stalled.attentionQueue).toMatchObject([{ attention: 'stage-blocked', reason: expect.stringContaining('every open ticket is blocked') }]);

    factory.github.close('acme/widgets#39');
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });
    const offered = await tui.until((state) => !!state.tasks.T1?.loop?.frontier);
    expect(offered.tasks.T1!.loop!.frontier!.map(({ ref }) => ref)).toEqual(['acme/widgets#31', 'acme/widgets#33']);
  });
});

describe('picking a ticket', () => {
  test('the operator picks a frontier ticket: a fresh HITL session on the map and that ticket', async () => {
    const { factory, operator, tui } = await working();

    expect(await operator.send({ type: 'open', taskId: 'T1', ticket: 'acme/widgets#33' })).toEqual({ ok: true });

    const opened = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(opened.tasks.T1).toMatchObject({ label: 'In conversation', loop: { ticket: 'acme/widgets#33', frontier: null } });
    const [chart, work] = factory.executor.started;
    expect(work).toMatchObject({ runId: 'R2', mode: 'HITL', resumesSession: false, cwd: chart!.cwd, model: 'claude-opus-5-5' });
    expect(work!.sessionId).not.toBe(chart!.sessionId);
    expect(work!.firstMessage).toMatch(/^\/factory:wayfinder acme\/widgets#30 acme\/widgets#33\n\n/);
    expect(work!.firstMessage).toContain('Invoice layout');
  });

  test('or takes the first: opening the task starts the first frontier ticket, each ticket in its own session', async () => {
    const { factory, operator, tui } = await working();

    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(factory.executor.started[1]!.firstMessage).toMatch(/^\/factory:wayfinder acme\/widgets#30 acme\/widgets#31\n\n/);

    factory.github.close('acme/widgets#31');
    await operator.send({ type: 'advanceStage', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.loop?.frontier?.[0]?.ref === 'acme/widgets#32');
    await operator.send({ type: 'open', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    const [, first, second] = factory.executor.started;
    expect(second!.firstMessage).toMatch(/^\/factory:wayfinder acme\/widgets#30 acme\/widgets#32\n\n/);
    expect(second).toMatchObject({ resumesSession: false });
    expect(second!.sessionId).not.toBe(first!.sessionId);
  });

  test('a ticket off the frontier is refused', async () => {
    const { operator } = await working();

    expect(await operator.send({ type: 'open', taskId: 'T1', ticket: 'acme/widgets#32' })).toEqual({ ok: false, reason: 'acme/widgets#32 isn’t on T1’s frontier.' });
  });

  test('advancing with no ticket picked yet is refused', async () => {
    const { operator } = await working();

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'T1 works no ticket of its map yet: pick one from its frontier first.',
    });
  });
});

// Worked to the end: every ticket of the map closed, and the map read again.
async function cleared() {
  const worked = await working();
  const { factory, operator, tui } = worked;
  await operator.send({ type: 'open', taskId: 'T1' });
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
  for (const ref of ['acme/widgets#31', 'acme/widgets#32', 'acme/widgets#33']) factory.github.close(ref);
  await operator.send({ type: 'advanceStage', taskId: 'T1' });
  await tui.until((state) => !!state.tasks.T1?.loop?.cleared);
  return worked;
}

describe('the map clearing', () => {
  test('map-cleared holds once the map has no open children: the task is Ready for you to choose where it goes', async () => {
    const { tui } = await cleared();

    const state = tui.state();
    expect(state.tasks.T1).toMatchObject({ stage: 'work', label: 'Ready for you', liveRunId: null, loop: { cleared: true, frontier: null } });
    expect(state.attentionQueue).toEqual([{ kind: 'ready', taskId: 'T1' }]);
  });

  test('opening a cleared map is refused: there is no ticket left', async () => {
    const { operator } = await cleared();

    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({ ok: false, reason: 'T1’s map has cleared: choose where it goes next.' });
  });

  test('continue to spec: a fresh session of the spec stage on the map', async () => {
    const { factory, operator, tui } = await cleared();

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });

    const spec = await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    expect(spec.tasks.T1).toMatchObject({ stage: 'spec', loop: null });
    const run = factory.executor.started.at(-1)!;
    expect(run).toMatchObject({ runId: 'R3', mode: 'HITL', resumesSession: false, firstMessage: '/factory:to-spec acme/widgets#30' });
    expect(run.sessionId).not.toBe(factory.executor.started[1]!.sessionId);
  });

  test('jump to tickets: the tickets stage starts on the map, the spec skipped', async () => {
    const { factory, operator, tui } = await cleared();

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1', skip: ['spec'] })).toEqual({ ok: true });

    expect((await tui.until((state) => state.tasks.T1?.liveRunId === 'R3')).tasks.T1).toMatchObject({ stage: 'tickets', loop: null });
    expect(factory.executor.started.at(-1)).toMatchObject({ runId: 'R3', firstMessage: '/factory:to-tickets acme/widgets#30' });
  });

  test('end: the task goes In review, no run started', async () => {
    const { factory, operator, tui } = await cleared();

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1', end: true })).toEqual({ ok: true });

    const ended = await tui.until((state) => state.tasks.T1?.state === 'in-review');
    expect(ended.tasks.T1).toMatchObject({ label: 'In review', loop: null });
    expect(ended.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
    expect(factory.executor.started).toHaveLength(2);
  });

  test('ending, or jumping, is refused before the map cleared', async () => {
    const { operator, tui } = await working();
    await operator.send({ type: 'open', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');

    const refused = { ok: false, reason: 'T1’s map hasn’t cleared: finish acme/widgets#31 first.' };
    expect(await operator.send({ type: 'advanceStage', taskId: 'T1', end: true })).toEqual(refused);
    expect(await operator.send({ type: 'advanceStage', taskId: 'T1', skip: ['spec'] })).toEqual(refused);
  });
});

describe('launching at the work loop', () => {
  test('with the map as an issue ref, the task starts on the map’s frontier', async () => {
    const factory = await startTestFactory();
    factories.push(factory);
    await factory.registerRepo();
    factory.github.addIssue(MAP);
    factory.github.addIssue('acme/widgets#31', { parent: MAP, title: 'Which payment provider?' });
    const operator = await factory.attach();
    const tui = watch(operator);

    const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'wayfinder', stage: 'work', issues: ['#30'] });
    expect(launched.ok).toBe(true);

    const offered = await tui.until((state) => !!state.tasks.T1?.loop?.frontier);
    expect(offered.tasks.T1).toMatchObject({ stage: 'work', label: 'Ready for you', liveRunId: null });
    expect(offered.tasks.T1!.loop!.frontier).toEqual([{ ref: 'acme/widgets#31', title: 'Which payment provider?' }]);
    expect(factory.executor.started).toEqual([]);
  });
});
