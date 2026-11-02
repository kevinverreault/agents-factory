// The Lifecycle's usage metering (ADR 0008), straight on the pure reducer:
// per-minute samples live in the store, not in the factory state.
import { describe, expect, test } from 'vitest';
import { SHIPPED_ROUTES } from '../models/routing.ts';
import { initialLifecycle, reduce, type Lifecycle, type LifecycleAction } from './lifecycle.ts';

const SONNET = 'claude-sonnet-5-5';
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) => ({ input, output, cacheRead, cacheWrite, cost });

// Applies each action at its time, failing on a refusal.
function play(state: Lifecycle, ...steps: [number, LifecycleAction][]): Lifecycle {
  for (const [at, action] of steps) {
    const { state: next, refusal } = reduce(state, action, at, SHIPPED_ROUTES);
    if (refusal) throw new Error(refusal);
    state = next;
  }
  return state;
}

// A HITL task open in conversation on run R1.
function conversing(): Lifecycle {
  return play(
    initialLifecycle(),
    [0, { type: 'repoRegistered', repo: 'acme/widgets', path: '/clones/widgets', baseBranch: 'main', defaultPreset: 'main-flow' }],
    [0, { type: 'createTask', title: 'Grill me about the login flow.', repo: 'acme/widgets', mode: 'HITL' }],
    [0, { type: 'open', taskId: 'T1' }],
  );
}

describe('per-minute samples', () => {
  test('count each API message once, however often it streams, and the run’s total corrects them in the minute it lands', () => {
    const state = play(
      conversing(),
      [10_000, { type: 'usageSampled', runId: 'R1', messageId: 'msg_1', model: SONNET, usage: usage(100, 10, 1_000, 50) }],
      // The same message again, its later content block counting more output.
      [12_000, { type: 'usageSampled', runId: 'R1', messageId: 'msg_1', model: SONNET, usage: usage(100, 30, 1_000, 50) }],
      [70_000, { type: 'usageSampled', runId: 'R1', messageId: 'msg_2', model: SONNET, usage: usage(200, 40) }],
      [90_000, { type: 'usageTotaled', runId: 'R1', models: { [SONNET]: usage(300, 75, 1_000, 50, 0.42) } }],
    );

    expect(Object.values(state.samples)).toEqual([
      { id: 'R1@0', runId: 'R1', minute: 0, models: { [SONNET]: usage(100, 30, 1_000, 50) } },
      { id: 'R1@60000', runId: 'R1', minute: 60_000, models: { [SONNET]: usage(200, 45, 0, 0, 0.42) } },
    ]);
    expect(state.runs.R1!.usage).toEqual({ [SONNET]: usage(300, 75, 1_000, 50, 0.42) });
  });

  test('a message still streaming once its run ended adds nothing, so it can’t count twice; a late total still corrects', () => {
    const state = play(
      conversing(),
      [10_000, { type: 'usageSampled', runId: 'R1', messageId: 'msg_1', model: SONNET, usage: usage(100, 10) }],
      [20_000, { type: 'cancel', taskId: 'T1' }],
    );
    expect(state.runs.R1!.status).toBe('ended');

    const late = play(state, [30_000, { type: 'usageSampled', runId: 'R1', messageId: 'msg_1', model: SONNET, usage: usage(100, 10) }]);
    expect(late.runs.R1!.usage).toEqual({ [SONNET]: usage(100, 10) });

    const totaled = play(late, [40_000, { type: 'usageTotaled', runId: 'R1', models: { [SONNET]: usage(100, 20, 0, 0, 0.01) } }]);
    expect(totaled.runs.R1!.usage).toEqual({ [SONNET]: usage(100, 20, 0, 0, 0.01) });
  });
});
