// Seam 1: AFK → AFK stage boundaries. When an AFK stage's run completes and
// its exit holds, the next stage starts with no operator action; otherwise a
// `stage-blocked` attention request says what's missing. Past the last stage
// the root task goes In review.
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

const prompt = 'Add a logout button.';

// A user preset of AFK stages, one per argument (YAML flow mapping fields).
const afk = (...stages: string[]) => `stages:\n${stages.map((stage) => `  - { kind: run, mode: AFK, ${stage} }\n`).join('')}`;

// A factory with T1 launched from the user preset `preset`, running its first
// stage on R1.
async function running(preset: string): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(join(factory.paths.presetsDir, 'unattended.preset.yaml'), preset);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt });
  if (!launched.ok) throw new Error(launched.reason);
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  return { factory, operator, tui };
}

// A tool of the task's latest run prints an issue's URL, as `gh issue create` does.
async function printIssue(factory: TestFactory, tui: Watched, number: number): Promise<void> {
  const { sessionId, cwd } = factory.executor.started.at(-1)!;
  const before = Object.keys(tui.state().artifacts).length;
  const event = { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh issue create' } };
  await relayHook(JSON.stringify({ ...event, tool_response: `https://github.com/acme/widgets/issues/${number}\n` }), factory.paths);
  await tui.until((state) => Object.keys(state.artifacts).length > before);
}

describe('advancing on its own', () => {
  test('a run that completes with its stage’s exit holding starts the next stage, with no operator action', async () => {
    const { factory, tui } = await running(
      afk('id: build, skill: implement, args: "{{prompt}}", model: sonnet, exit: run-completed', 'id: check, skill: code-review, model: haiku, context: fresh'),
    );

    factory.executor.report('R1', { type: 'runCompleted' });

    const advanced = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(advanced.tasks.T1).toMatchObject({ stage: 'check', label: 'Running' });
    expect(advanced.runs.R1).toMatchObject({ status: 'ended', outcome: 'completed', stage: 'build' });
    expect(advanced.runs.R2).toMatchObject({ status: 'active', stage: 'check', mode: 'AFK' });
    expect(advanced.attentionQueue).toEqual([]);
    const [build, check] = factory.executor.started;
    expect(check).toMatchObject({ runId: 'R2', mode: 'AFK', resumesSession: false, firstMessage: '/factory:code-review', model: 'claude-haiku-5-5' });
    // A fresh-context stage starts a session of its own.
    expect(check!.sessionId).not.toBe(build!.sessionId);
    expect(advanced.tasks.T1?.sessionId).toBe(check!.sessionId);
  });
});

describe('past the last stage', () => {
  test('the root task goes In review and is listed in Needs you; a stage that requires L2 is skipped at L1', async () => {
    const { factory, tui } = await running(
      `${afk('id: build, skill: implement, args: "{{prompt}}"')}  - { id: open-pr, kind: action, mode: AFK, requires: L2 }\n`,
    );

    factory.executor.report('R1', { type: 'runCompleted' });

    const reviewed = await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(reviewed.tasks.T1).toMatchObject({ stage: 'build', liveRunId: null });
    expect(reviewed.runs.R1).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(reviewed.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
    expect(factory.executor.started).toHaveLength(1);
  });
});

describe('the autonomy level', () => {
  test('changes only between runs, and a level above the stage’s ceiling is clamped to it', async () => {
    const { factory, operator, tui } = await running(
      afk('id: draft, skill: to-spec, args: "{{prompt}}", autonomy: L1, exit: "artifact:spec"', 'id: build, skill: implement, args: "{{artifacts.spec}}"'),
    );

    expect(await operator.send({ type: 'setAutonomy', taskId: 'T1', autonomy: 'L2' })).toEqual({
      ok: false,
      reason: 'T1’s autonomy level changes only between runs, and its run R1 is live.',
    });

    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(await operator.send({ type: 'setAutonomy', taskId: 'T1', autonomy: 'L2' })).toEqual({ ok: true });
    expect(tui.state().tasks.T1?.autonomy).toBe('L1');
  });

  test('L2 with no ceiling to clamp it is refused, as is a level for a HITL task', async () => {
    const { factory, operator, tui } = await running(afk('id: draft, skill: to-spec, args: "{{prompt}}", exit: "artifact:spec"'));
    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    expect(await operator.send({ type: 'setAutonomy', taskId: 'T1', autonomy: 'L2' })).toEqual({
      ok: false,
      reason: 'L2 runs in a sandbox, which the factory doesn’t have yet: stay at L1.',
    });
    expect(await operator.send({ type: 'setAutonomy', taskId: 'T1', autonomy: 'L1' })).toEqual({ ok: true });

    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Plan the billing page', mode: 'HITL' });
    expect(await operator.send({ type: 'setAutonomy', taskId: 'T2', autonomy: 'L1' })).toEqual({
      ok: false,
      reason: 'T2 is HITL, so it has no autonomy level.',
    });
  });
});

describe('when the next stage can’t start', () => {
  test('args the task has nothing to fill with raise a stage-blocked attention request naming what’s missing', async () => {
    const { factory, tui } = await running(afk('id: build, skill: implement, args: "{{prompt}}"', 'id: check, skill: code-review, args: "{{artifacts.spec}}"'));

    factory.executor.report('R1', { type: 'runCompleted' });

    const blocked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(blocked.tasks.T1?.stage).toBe('build');
    expect(blocked.attentionQueue).toMatchObject([
      { attention: 'stage-blocked', reason: 'check can’t start: its args need {{artifacts.spec}}, and T1 has no spec.' },
    ]);
    expect(factory.executor.started).toHaveLength(1);
  });

  test('an exit that doesn’t hold raises a stage-blocked attention request instead of starting the next stage', async () => {
    const { factory, tui } = await running(
      afk('id: draft, skill: to-spec, args: "{{prompt}}", exit: "artifact:spec"', 'id: build, skill: implement, args: "{{artifacts.spec}}"'),
    );

    factory.executor.report('R1', { type: 'runCompleted' });

    const blocked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(blocked.tasks.T1).toMatchObject({ stage: 'draft', liveRunId: null });
    expect(blocked.runs.R1).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(blocked.attentionQueue).toEqual([
      {
        kind: 'attention',
        taskId: 'T1',
        repo: 'acme/widgets',
        requestId: 'A1',
        attention: 'stage-blocked',
        holdsRun: false,
        reason: 'draft’s exit, artifact:spec, doesn’t hold: T1 has no spec yet.',
        question: null,
        permission: null,
      },
    ]);
    expect(factory.executor.started).toHaveLength(1);
  });

  test('once answered, the stage carries on told what was missing, and its next completion checks the exit again', async () => {
    const { factory, operator, tui } = await running(
      afk('id: draft, skill: to-spec, args: "{{prompt}}", exit: "artifact:spec"', 'id: build, skill: implement, args: "{{artifacts.spec}}"'),
    );
    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(factory.executor.started.at(-1)).toMatchObject({
      resumesSession: true,
      firstMessage:
        'The factory couldn’t move this task on: draft’s exit, artifact:spec, doesn’t hold: T1 has no spec yet.\n\n' +
        'Carry on, unattended, from where this conversation left off.',
    });
    expect(tui.state().runs.R2).toMatchObject({ stage: 'draft' });

    await printIssue(factory, tui, 41);
    factory.executor.report('R2', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    expect(tui.state().tasks.T1?.stage).toBe('build');
    expect(factory.executor.started.at(-1)).toMatchObject({ resumesSession: true, firstMessage: '/factory:implement acme/widgets#41' });
  });
});
