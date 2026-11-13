// Seam 1: the retired Ralph loop (ADR 0013), through the client protocol.
// A preset naming its exit, `tickets-closed`, is refused at launch. A task
// launched before it was retired, its preset frozen with the loop, asks the
// operator to cancel or relaunch it: once it reaches the loop's stage, or at
// the daemon's start if it is already there. Nothing is migrated.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Stage } from '../presets/presets.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import { openStore } from '../store/store.ts';
import { handOff } from '../testing/handoff.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

// The old implement stage: the Ralph loop over a spec's tickets.
const RALPH_LOOP: Stage = { id: 'implement', kind: 'loop', skill: 'implement', args: '{{artifacts.tickets}}', mode: 'AFK', model: 'sonnet', context: 'fresh', exit: 'tickets-closed' };
const RETIRED =
  'This preset’s loop was retired: implement works tickets through the Ralph loop (exit tickets-closed), which the factory no longer runs. Cancel T1, or relaunch it.';

async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

function writeUserPreset(factory: TestFactory, name: string, yaml: string): string {
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  const path = join(factory.paths.presetsDir, `${name}.preset.yaml`);
  writeFileSync(path, yaml);
  return path;
}

// T1 launched on a two-stage preset, `build` (AFK, or HITL with `firstMode`)
// then `implement`, its build run R1 live. The daemon then stops, and
// `freeze` edits T1 in the store as a daemon from before the loop was
// retired would have left it; a new daemon starts over the store.
async function frozen(freeze: (task: { preset: { stages: Stage[] }; stage: string; loop?: unknown }) => void, firstMode: Stage['mode'] = 'AFK') {
  const { factory, operator, tui } = await attached();
  writeUserPreset(
    factory,
    'two-step',
    'stages:\n' +
      `  - { id: build, kind: run, skill: implement, args: "{{prompt}}", mode: ${firstMode}, exit: run-completed }\n` +
      '  - { id: implement, kind: run, skill: implement, mode: AFK, exit: run-completed }\n',
  );
  expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'two-step', prompt: 'Add a logout button.' })).toMatchObject({ ok: true });
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  operator.close();
  await factory.daemon().stop();
  const store = openStore(factory.paths.storePath);
  const saved = store.loadLifecycle()!;
  freeze(saved.tasks.T1 as never);
  store.saveLifecycle(saved);
  store.close();
  await factory.startDaemon();
  const restarted = await factory.attach();
  return { factory, operator: restarted, tui: watch(restarted) };
}

describe('a preset naming tickets-closed', () => {
  test('is refused at launch, saying the loop was retired', async () => {
    const { factory, operator } = await attached();
    factory.github.addIssue('acme/widgets#10');
    const path = writeUserPreset(factory, 'main-flow', 'extends: main-flow\nstages:\n  - id: implement\n    kind: loop\n    exit: tickets-closed\n');

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', issues: ['#10'] })).toEqual({
      ok: false,
      reason:
        `Preset main-flow (user, ${path}): stage implement: exit tickets-closed was the Ralph loop’s, which is retired: ` +
        'work a spec’s tickets with kind: tickets and exit spec-closed instead (ADR 0013).',
    });
    expect(factory.executor.started).toEqual([]);
  });
});

describe('a task frozen on the Ralph loop', () => {
  test('reaching the loop’s stage raises stage-blocked saying it was retired, and runs nothing there', async () => {
    const { factory, operator, tui } = await frozen((task) => {
      task.preset.stages[1] = RALPH_LOOP;
    });
    // The build run, interrupted by the stop, resumes.
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');

    factory.executor.report('R2', { type: 'runCompleted' });

    const blocked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(blocked.tasks.T1).toMatchObject({ stage: 'implement', loop: null, liveRunId: null });
    expect(blocked.attentionQueue).toMatchObject([{ attention: 'stage-blocked', taskId: 'T1', reason: RETIRED }]);
    expect(factory.executor.started.map(({ runId }) => runId)).toEqual(['R1', 'R2']);
    expect(factory.github.writes).toEqual([]);
    // Only cancelling, or relaunching, carries it on.
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: false, reason: RETIRED });
    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: false, reason: RETIRED });
    expect(await operator.send({ type: 'cancel', taskId: 'T1', branch: 'discard' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.label === 'Cancelled');
  });

  test('handed off to the loop’s stage raises stage-blocked saying it was retired, and runs nothing there', async () => {
    const { factory, operator, tui } = await frozen((task) => {
      task.preset.stages[1] = RALPH_LOOP;
    }, 'HITL');
    // The conversation, parked by the stop, is Ready for you again.
    await tui.until((state) => state.tasks.T1?.label === 'Ready for you');
    await operator.send({ type: 'open', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');

    await handOff(operator, tui, factory.executor, 'T1');

    const blocked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(blocked.tasks.T1).toMatchObject({ mode: 'AFK', stage: 'implement', loop: null, liveRunId: null });
    expect(blocked.attentionQueue).toMatchObject([{ attention: 'stage-blocked', taskId: 'T1', reason: RETIRED }]);
    expect(factory.executor.started.map(({ runId }) => runId)).toEqual(['R1', 'R2']);
  });

  test('advanced to a HITL loop’s stage on the advance sheet raises stage-blocked saying it was retired', async () => {
    const { factory, operator, tui } = await frozen((task) => {
      task.preset.stages[1] = { ...RALPH_LOOP, mode: 'HITL' };
    }, 'HITL');
    await tui.until((state) => state.tasks.T1?.label === 'Ready for you');
    await operator.send({ type: 'open', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });

    const blocked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(blocked.tasks.T1).toMatchObject({ stage: 'implement', loop: null, liveRunId: null });
    expect(blocked.attentionQueue).toMatchObject([{ attention: 'stage-blocked', taskId: 'T1', reason: RETIRED }]);
    expect(factory.executor.started.map(({ runId }) => runId)).toEqual(['R1', 'R2']);
  });

  test('already at the loop’s stage when the daemon starts raises stage-blocked saying it was retired, once however often it restarts', async () => {
    const { factory, tui } = await frozen((task) => {
      task.preset.stages[0] = { ...RALPH_LOOP, id: 'build' };
      // As the old loop left it, about to pick its next ticket.
      task.loop = { step: 'pick', ticket: null, base: null, commits: [] };
    });

    const blocked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    const reason = RETIRED.replace('implement works', 'build works');
    expect(blocked.tasks.T1).toMatchObject({ stage: 'build', loop: null, liveRunId: null });
    expect(blocked.attentionQueue).toMatchObject([{ attention: 'stage-blocked', taskId: 'T1', reason }]);
    expect(factory.executor.started.map(({ runId }) => runId)).toEqual(['R1']);

    await factory.restart();
    const again = watch(await factory.attach());

    const state = await again.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(state.attentionQueue).toMatchObject([{ attention: 'stage-blocked', taskId: 'T1', reason }]);
    expect(factory.executor.started.map(({ runId }) => runId)).toEqual(['R1']);
  });
});
