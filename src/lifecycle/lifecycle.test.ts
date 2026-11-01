// The Lifecycle reducer, directly: child tasks can't be spawned through the
// protocol yet, so the task tree is seeded here, then driven through `reduce`.
import { describe, expect, test } from 'vitest';
import { SHIPPED_ROUTES } from '../models/routing.ts';
import { initialLifecycle, reduce, type Lifecycle, type LifecycleAction } from './lifecycle.ts';

function apply(state: Lifecycle, ...actions: LifecycleAction[]): Lifecycle {
  for (const action of actions) {
    const { state: next, refusal } = reduce(state, action, 0, SHIPPED_ROUTES);
    if (refusal) throw new Error(refusal);
    state = next;
  }
  return state;
}

// Each task's state, by id.
const states = (state: Lifecycle) => Object.fromEntries(Object.values(state.tasks).map((task) => [task.id, task.state]));

const afk = (title: string): LifecycleAction => ({ type: 'createTask', repo: 'acme/widgets', title, mode: 'AFK', submit: true });

// T1 is a root with children T2 (itself the parent of T3) and T4, which is
// Done; T5 is another root. Each AFK task got a run: R1 to R5. T3's run
// failed, so T3 needs the operator.
function taskTree(): Lifecycle {
  let state = apply(
    initialLifecycle(),
    { type: 'repoRegistered', repo: 'acme/widgets', path: '/clones/widgets', baseBranch: 'main', defaultPreset: 'main-flow' },
    { type: 'setSlotCap', cap: 5 },
    afk('Ship the logout flow'),
    afk('Add the button'),
    afk('Style the button'),
    afk('Write the docs'),
    afk('Something else'),
  );
  state = structuredClone(state);
  state.tasks.T2!.parentId = 'T1';
  state.tasks.T3!.parentId = 'T2';
  state.tasks.T4!.parentId = 'T1';
  return apply(
    state,
    { type: 'runFailed', runId: 'R3', reason: 'The agent hit max turns.' },
    { type: 'runCompleted', runId: 'R4' },
    { type: 'markDone', taskId: 'T4' },
  );
}

describe('cancelling a task tree', () => {
  test('cancels every unfinished descendant, ends their live runs cancelled and closes their open requests', () => {
    const state = apply(taskTree(), { type: 'cancel', taskId: 'T1' });

    expect(states(state)).toEqual({ T1: 'cancelled', T2: 'cancelled', T3: 'cancelled', T4: 'done', T5: 'running' });
    expect(state.runs.R1).toMatchObject({ status: 'ended', outcome: 'cancelled' });
    expect(state.runs.R2).toMatchObject({ status: 'ended', outcome: 'cancelled' });
    // The failure stays on the run; the task itself ends Cancelled.
    expect(state.runs.R3).toMatchObject({ status: 'ended', outcome: 'failed' });
    expect(Object.values(state.requests).map(({ taskId, status }) => ({ taskId, status }))).toEqual([{ taskId: 'T3', status: 'closed' }]);
    expect(state.runs.R5).toMatchObject({ status: 'active' });
  });

  test('cancelling a child cancels its own subtree only', () => {
    const state = apply(taskTree(), { type: 'cancel', taskId: 'T2' });

    expect(states(state)).toEqual({ T1: 'running', T2: 'cancelled', T3: 'cancelled', T4: 'done', T5: 'running' });
  });
});
