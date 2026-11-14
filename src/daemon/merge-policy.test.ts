// Seam 1: a task's merge policy after launch (ADR 0014), through the client
// protocol. A spec task's ticket tasks inherit it. The operator can change
// it on a live AFK root at L3, as they can its level; on a spec task the
// change reaches the ticket tasks not yet at their gate, and leaves those
// already there alone. Lowering a task below L3 resets it to `operator`.
// A `ready-for-human` ticket still launches HITL under every policy, and
// its handoff sheet pre-fills its spec's policy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { throughPr } from '../testing/through-pr.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const READY = ['ready-for-agent'];
const SPEC = 'acme/widgets#10';
const MINUTE = 60_000;

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

// A factory with a subscription token for contained runs, the spec #10 on
// GitHub with its tickets #11 and #15, both ready, and the user preset
// `capped` when given.
async function attached({ capped }: { capped?: string } = {}): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  if (capped) {
    mkdirSync(factory.paths.presetsDir, { recursive: true });
    writeFileSync(join(factory.paths.presetsDir, 'capped.preset.yaml'), capped);
  }
  await factory.registerRepo();
  factory.github.addIssue(SPEC, { title: 'Sign-in' });
  factory.github.addIssue('acme/widgets#11', { title: 'A login form', parent: SPEC, labels: READY });
  factory.github.addIssue('acme/widgets#15', { title: 'Sign out', parent: SPEC, labels: READY });
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

// `implement` launched on the spec ref at L3.
const onSpec = (extra: Partial<LaunchCommand> = {}): LaunchCommand => ({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', issues: ['#10'], autonomy: 'L3', ...extra });

// One implement run on a brief, at L3.
const onBrief = (extra: Partial<LaunchCommand> = {}): LaunchCommand => ({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: 'Add a logout button.', autonomy: 'L3', ...extra });

// The ticket tasks, by their ticket.
const ticketTasks = (state: FactoryState) =>
  Object.fromEntries(Object.values(state.tasks).flatMap((task) => (task.kind === 'ticket' && task.ticket ? [[task.ticket, task.id]] : [])));

describe('ticket tasks', () => {
  test('a full-auto spec task’s ticket tasks are full-auto too', async () => {
    const { operator, tui } = await attached();

    await operator.send(onSpec({ mergePolicy: 'unattended' }));

    const state = await tui.until((state) => !!state.tasks.T2?.liveRunId && !!state.tasks.T3?.liveRunId);
    expect(state.tasks.T1).toMatchObject({ kind: 'spec', mergePolicy: 'unattended' });
    expect(state.tasks.T2).toMatchObject({ kind: 'ticket', specTask: 'T1', autonomy: 'L3', mergePolicy: 'unattended' });
    expect(state.tasks.T3).toMatchObject({ kind: 'ticket', specTask: 'T1', autonomy: 'L3', mergePolicy: 'unattended' });
  });
});

describe('changing a live task’s merge policy', () => {
  test('works at L3, and is refused below it, on a HITL task, or with a policy that isn’t one', async () => {
    const { operator, tui } = await attached();
    await operator.send(onBrief());
    await operator.send(onBrief({ autonomy: 'L2' }));
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me.' });
    await tui.until((state) => !!state.tasks.T3);

    expect(await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'unattended' })).toEqual({ ok: true });
    expect(tui.state().tasks.T1?.mergePolicy).toBe('unattended');
    expect(await operator.send({ type: 'setMergePolicy', taskId: 'T2', mergePolicy: 'unattended' })).toEqual({
      ok: false,
      reason: 'Full-auto (unattended) merges the task’s PR, which the factory does only at L3: pick L3, or the operator policy.',
    });
    expect(await operator.send({ type: 'setMergePolicy', taskId: 'T3', mergePolicy: 'unattended' })).toEqual({
      ok: false,
      reason: 'T3 is HITL: it picks its merge policy at its handoff.',
    });
    expect(await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'yolo' as never })).toEqual({ ok: false, reason: 'yolo is not a merge policy (operator, judged or unattended).' });
    expect(tui.state().tasks.T2?.mergePolicy).toBe('operator');

    expect(await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'operator' })).toEqual({ ok: true });
    expect(tui.state().tasks.T1?.mergePolicy).toBe('operator');
  });

  test('a task In review set to full-auto goes to its merge gate and its PR merges; one at its gate set back to operator goes In review', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(onBrief());
    await throughPr(launched, 'T1');
    expect(tui.state().tasks.T1?.label).toBe('In review');

    await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'unattended' });
    let state = await tui.until((state) => state.tasks.T1?.gate?.checks === 'none');
    expect(state.tasks.T1?.label).toBe('At merge gate');
    expect(state.attentionQueue).toEqual([]);

    await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'operator' });
    state = tui.state();
    expect(state.tasks.T1).toMatchObject({ label: 'In review', gate: null });
    expect(state.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
    factory.clock.advance(2 * MINUTE);
    await operator.send({ type: 'daemon.status' });
    expect(factory.github.prWrites).toEqual([]);

    await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'unattended' });
    await tui.until((state) => state.tasks.T1?.gate?.checks === 'none');
    factory.clock.advance(2 * MINUTE);
    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(factory.github.prState(101).state).toBe('merged');
  });

  test('on a spec task, it reaches the ticket tasks not yet at their gate, and those launched later, leaving one already there alone', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    factory.github.addIssue('acme/widgets#16', { title: 'Remember me', parent: SPEC, labels: READY, blockedBy: ['acme/widgets#11'] });
    await operator.send(onSpec());
    await tui.until((state) => !!state.tasks.T2?.liveRunId && !!state.tasks.T3?.liveRunId);
    await throughPr(launched, 'T2');

    expect(await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'unattended' })).toEqual({ ok: true });

    let state = tui.state();
    expect(state.tasks.T1?.mergePolicy).toBe('unattended');
    // Already In review, at its gate under the operator policy.
    expect(state.tasks.T2).toMatchObject({ label: 'In review', mergePolicy: 'operator' });
    expect(state.tasks.T3?.mergePolicy).toBe('unattended');

    // The operator merges T2; #16, unblocked, launches under the new policy.
    factory.github.merge(101);
    // Another TUI subscribing makes the daemon read the PR.
    watch(await factory.attach());
    state = await tui.until((state) => !!ticketTasks(state)['acme/widgets#16']);
    expect(state.tasks[ticketTasks(state)['acme/widgets#16']!]?.mergePolicy).toBe('unattended');
  });

  test('a ticket task lowered below L3 isn’t raised to full-auto by its spec task', async () => {
    const { operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(onSpec());
    await tui.until((state) => !!state.tasks.T2?.liveRunId && state.tasks.T3?.state === 'queued');

    expect(await operator.send({ type: 'setAutonomy', taskId: 'T3', autonomy: 'L2' })).toEqual({ ok: true });
    expect(await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'unattended' })).toEqual({ ok: true });

    expect(tui.state().tasks.T2?.mergePolicy).toBe('unattended');
    expect(tui.state().tasks.T3).toMatchObject({ autonomy: 'L2', mergePolicy: 'operator' });
  });
});

describe('a preset stage capped at L2', () => {
  // An L3 task's runs at a stage whose ceiling is L2 run at L2, and its gate
  // goes by its last stage's ceiling.
  const stages = (first: string, last: string) =>
    `stages:\n  - { id: build, kind: run, mode: AFK, skill: implement, args: "{{prompt}}"${first} }\n  - { id: check, kind: run, mode: AFK, skill: code-review${last} }\n`;
  const capped = { type: 'launchTask', repo: 'acme/widgets', preset: 'capped', prompt: 'Add a logout button.', autonomy: 'L3' } as const;

  test('as the last one, refuses full-auto on an L3 task, which could never merge at its gate', async () => {
    const { operator, tui } = await attached({ capped: stages('', ', autonomy: L2') });
    await operator.send(capped);
    await tui.until((state) => !!state.tasks.T1?.liveRunId);

    expect(await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'unattended' })).toEqual({
      ok: false,
      reason: 'Full-auto (unattended) merges the task’s PR, which the factory does only at L3: pick L3, or the operator policy.',
    });
  });

  test('before the last one, takes full-auto on an L3 task, which merges past it', async () => {
    const { operator, tui } = await attached({ capped: stages(', autonomy: L2', '') });
    await operator.send(capped);
    await tui.until((state) => !!state.tasks.T1?.liveRunId);

    expect(await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'unattended' })).toEqual({ ok: true });
    expect(tui.state().tasks.T1?.mergePolicy).toBe('unattended');
  });
});

describe('lowering a task below L3', () => {
  test('resets its merge policy to operator', async () => {
    const { operator, tui } = await attached();
    await operator.send(onBrief({ mergePolicy: 'unattended' }));
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(onBrief({ mergePolicy: 'unattended' }));
    await tui.until((state) => state.tasks.T2?.state === 'queued');

    expect(await operator.send({ type: 'setAutonomy', taskId: 'T2', autonomy: 'L3' })).toEqual({ ok: true });
    expect(tui.state().tasks.T2?.mergePolicy).toBe('unattended');
    expect(await operator.send({ type: 'setAutonomy', taskId: 'T2', autonomy: 'L2' })).toEqual({ ok: true });
    expect(tui.state().tasks.T2).toMatchObject({ autonomy: 'L2', mergePolicy: 'operator' });
  });
});

describe('a ready-for-human ticket under a full-auto spec', () => {
  test('still launches HITL, and its handoff sheet pre-fills L3 and full-auto, which it carries on under once handed off', async () => {
    const { factory, operator, tui } = await attached();
    factory.github.addIssue('acme/widgets#16', { title: 'Brand the login', parent: SPEC, labels: ['ready-for-human'] });
    await operator.send(onSpec({ mergePolicy: 'unattended' }));
    await tui.until((state) => state.tasks.T4?.label === 'Ready for you');
    expect(tui.state().tasks.T4).toMatchObject({ kind: 'ticket', ticket: 'acme/widgets#16', mode: 'HITL' });

    await operator.send({ type: 'open', taskId: 'T4' });
    const conversation = (await tui.until((state) => !!state.tasks.T4?.liveRunId)).tasks.T4!.liveRunId!;
    factory.executor.report(conversation, { type: 'turnEnded' });
    await operator.send({ type: 'openHandoff', taskId: 'T4' });
    const brief = { goal: 'Brand the login form.', decided: [], doneWhen: [], outOfScope: [], links: [] };
    factory.executor.report(conversation, { type: 'briefWritten', brief });
    factory.executor.report(conversation, { type: 'turnEnded' });

    const sheet = (await tui.until((state) => !!state.tasks.T4?.handoff?.brief)).tasks.T4!.handoff!;
    expect(sheet).toMatchObject({ autonomy: 'L3', mergePolicy: 'unattended' });
    // A change on the spec task meanwhile reaches the open sheet, and back.
    await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'operator' });
    expect(tui.state().tasks.T4?.handoff?.mergePolicy).toBe('operator');
    await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'unattended' });
    expect(tui.state().tasks.T4?.handoff?.mergePolicy).toBe('unattended');
    const { continueAs, autonomy, mergePolicy, tier, maxTurns } = sheet;
    expect(await operator.send({ type: 'handoff', taskId: 'T4', brief, continueAs, autonomy, mergePolicy, tier, maxTurns })).toEqual({ ok: true });
    expect(tui.state().tasks.T4).toMatchObject({ mode: 'AFK', autonomy: 'L3', mergePolicy: 'unattended' });
  });
});

