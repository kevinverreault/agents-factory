// The draft PR a root opens (ADR 0004), straight on the pure Lifecycle: its
// title and the body above the factory's footer.
import { describe, expect, test } from 'vitest';
import { SHIPPED_ROUTES } from '../models/routing.ts';
import { initialLifecycle, pullRequestOf, reduce, type Lifecycle, type Task } from './lifecycle.ts';

// A Lifecycle with T1 created, its fields as `more` says.
function withTask(more: Partial<Task>): { state: Lifecycle; task: Task } {
  let state = initialLifecycle();
  for (const action of [
    { type: 'repoRegistered', repo: 'acme/widgets', path: '/clones/widgets', baseBranch: 'main', defaultPreset: 'main-flow' },
    { type: 'createTask', title: 'Agent-written task names', repo: 'acme/widgets', mode: 'AFK' },
  ] as const) {
    const reduced = reduce(state, action, 0, SHIPPED_ROUTES);
    if (reduced.refusal) throw new Error(reduced.refusal);
    state = reduced.state;
  }
  const task = Object.assign(state.tasks.T1!, more);
  return { state, task };
}

// The PR T1 opens, with its fields as `more` says.
function pr(more: Partial<Task>): { title: string; body: string } {
  const { state, task } = withTask(more);
  return pullRequestOf(state, task);
}
// The body above the factory's footer.
const body = (more: Partial<Task>) => pr(more).body.split('\n\n---\n')[0];

describe('pullRequestOf', () => {
  test('takes the PR title the PR body stage wrote, else the task’s title', () => {
    expect(pr({ prBody: 'Body.', prTitle: 'Name tasks with a model' }).title).toBe('Name tasks with a model');
    expect(pr({ prBody: 'Body.', prTitle: null }).title).toBe('Agent-written task names');
  });

  test('its body is the written PR body, else the brief, else the launch summary, else the title', () => {
    const summary = 'Names tasks with a model.';
    expect(body({ prBody: 'Written.', brief: 'The brief.', launchSummary: summary })).toBe('Written.');
    expect(body({ brief: 'The brief.', launchSummary: summary })).toBe('The brief.');
    expect(body({ launchSummary: summary })).toBe(summary);
    expect(body({ launchSummary: '  ' })).toBe('Agent-written task names');
    expect(body({})).toBe('Agent-written task names');
  });
});
