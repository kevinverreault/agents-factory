// Seam 1: model routing (ADR 0009). Each run's tier resolves, when the run
// starts, to the exact model the operator's routing table names, and the run
// records both. The operator can re-tier a task between runs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { routingTable } from '../models/routing-table.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(join(factory.paths.presetsDir, 'talks.preset.yaml'), TALKS);
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

const prompt = 'Grill me about the login flow.';
// Three HITL stages at opus, each advancing on the operator's confirm alone.
const TALKS = `stages:
${['grill', 'spec', 'tickets'].map((id) => `  - { id: ${id}, kind: run, skill: grill-me, args: "{{prompt}}", mode: HITL, model: opus }
`).join('')}`;
const talks = { type: 'launchTask', repo: 'acme/widgets', preset: 'talks', prompt } as const;
const pinned = { opus: 'claude-opus-5-5-20261001', sonnet: 'claude-sonnet-5-5-20261001', haiku: 'claude-haiku-5-5-20261001' };

describe('routing a run', () => {
  test('a run started at sonnet uses the exact model the routing table names for it, and records both', async () => {
    const { factory, operator, tui } = await attached();
    writeFileSync(factory.paths.modelsTable, Object.entries(pinned).map(([tier, model]) => `${tier}: ${model}\n`).join(''));

    expect(await operator.send({ ...talks, tier: 'sonnet' })).toMatchObject({ ok: true });

    const started = await tui.until((state) => state.runs.R1 !== undefined);
    expect(started.runs.R1).toMatchObject({ tier: 'sonnet', model: 'claude-sonnet-5-5-20261001' });
    expect(factory.executor.started).toMatchObject([{ runId: 'R1', model: 'claude-sonnet-5-5-20261001' }]);
  });

  test('only an update moves a tier’s model, and only for the runs that start after it', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(talks);
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');

    // A later factory ships another opus: the table keeps routing the old one.
    const table = routingTable(factory.paths.modelsTable, { opus: 'claude-opus-6', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' });
    await operator.send({ type: 'advanceStage', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');

    table.update(table.planUpdate());
    await operator.send({ type: 'advanceStage', taskId: 'T1' });

    const state = await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    expect([state.runs.R1?.model, state.runs.R2?.model, state.runs.R3?.model]).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-6']);
  });

  test('a routing table that can’t be read starts no run, and says how to fix it', async () => {
    const { factory, operator } = await attached();
    writeFileSync(factory.paths.modelsTable, 'opus: opus\n');

    const reply = await operator.send(talks);

    expect(reply).toEqual({
      ok: false,
      reason: expect.stringMatching(/^The routing table at .*models\.yaml can’t be read: .*Fix it, or run `agents-factory models update`/),
    });
    expect(factory.executor.started).toEqual([]);
  });

  test('while the table can’t be read, queued AFK tasks wait, and what freed their slot still happens', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Fix the login bug', mode: 'AFK', submit: true });
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Add dark mode', mode: 'AFK', submit: true });
    await tui.until((state) => state.tasks.T2?.label === 'Queued');
    writeFileSync(factory.paths.modelsTable, 'opus: opus\n');

    factory.executor.report('R1', { type: 'runCompleted' });
    const completed = await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(completed.tasks.T2?.label).toBe('Queued');

    const table = routingTable(factory.paths.modelsTable);
    table.update(table.planUpdate());
    await operator.send({ type: 'markDone', taskId: 'T1' });
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    expect(factory.executor.started.at(-1)).toMatchObject({ taskId: 'T2', model: 'claude-sonnet-5-5' });
  });
});

describe('re-tiering a task', () => {
  test('applies to the task’s next run, never its live one, and beats every later stage’s tier', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(talks);
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');

    expect(await operator.send({ type: 'retier', taskId: 'T1', tier: 'haiku' })).toEqual({ ok: true });

    const retiered = await tui.until((state) => state.tasks.T1?.tier === 'haiku');
    expect(retiered.runs.R1).toMatchObject({ status: 'active', tier: 'opus', model: 'claude-opus-5-5' });
    expect(factory.executor.stopped).toEqual([]);

    await operator.send({ type: 'advanceStage', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    await operator.send({ type: 'advanceStage', taskId: 'T1' });
    const advanced = await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    expect([advanced.runs.R2?.tier, advanced.runs.R3?.tier]).toEqual(['haiku', 'haiku']);
    expect(factory.executor.started.map((run) => run.model)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5']);
  });

  test('a queued AFK task starts at the tier it was re-tiered to', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Fix the login bug', mode: 'AFK', submit: true });
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Add dark mode', mode: 'AFK', submit: true });
    await tui.until((state) => state.tasks.T2?.label === 'Queued');

    await operator.send({ type: 'retier', taskId: 'T2', tier: 'opus' });
    factory.executor.report('R1', { type: 'runCompleted' });

    const started = await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    expect([started.runs.R1?.tier, started.runs.R2?.tier]).toEqual(['sonnet', 'opus']);
    expect(factory.executor.started.at(-1)).toMatchObject({ taskId: 'T2', model: 'claude-opus-5-5' });
  });

  test('is refused for a tier that doesn’t exist, or a task that is finished', async () => {
    const { operator, tui } = await attached();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Fix the login bug', mode: 'AFK', submit: true });
    await tui.until((state) => state.tasks.T1 !== undefined);

    expect(await operator.send({ type: 'retier', taskId: 'T1', tier: 'gpt' as never })).toEqual({
      ok: false,
      reason: 'gpt is not a model tier (opus, sonnet or haiku).',
    });
    await operator.send({ type: 'cancel', taskId: 'T1' });
    expect(await operator.send({ type: 'retier', taskId: 'T1', tier: 'opus' })).toEqual({ ok: false, reason: 'T1 is already Cancelled.' });
  });
});
