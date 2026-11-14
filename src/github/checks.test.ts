// Pure module: how the GitHub adapter reads a commit's check runs and
// commit statuses into the merge gate's checks (ADR 0014).
import { describe, expect, test } from 'vitest';
import { checkRunState, combinedChecks, commitChecks, statusState } from './github.ts';

describe('a check run', () => {
  test('is pending until it completes, whatever it has concluded so far', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) expect(checkRunState({ status, conclusion: null })).toBe('pending');
  });

  test('once completed, passes on success, neutral or skipped, as GitHub’s merge box counts them', () => {
    for (const conclusion of ['success', 'neutral', 'skipped']) expect(checkRunState({ status: 'completed', conclusion })).toBe('green');
  });

  test('once completed, fails on anything else', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', null]) {
      expect(checkRunState({ status: 'completed', conclusion })).toBe('red');
    }
  });
});

describe('a commit status', () => {
  test('is green on success, pending while pending, and red on failure or error', () => {
    expect(['success', 'pending', 'failure', 'error'].map(statusState)).toEqual(['green', 'pending', 'red', 'red']);
  });
});

describe('the combined checks', () => {
  test('are none with no check run and no status', () => {
    expect(combinedChecks([], [])).toBe('none');
  });

  test('are red once any one is red, else pending while any is pending, else green', () => {
    expect(combinedChecks(['green', 'pending'], ['red'])).toBe('red');
    expect(combinedChecks(['green'], ['pending'])).toBe('pending');
    expect(combinedChecks(['green', 'green'], [])).toBe('green');
    expect(combinedChecks([], ['green'])).toBe('green');
  });
});

describe('a commit’s checks', () => {
  test('name each failed check run and commit status, with the page that says why, GitHub’s check page before the integrator’s', () => {
    const runs = [
      { name: 'build', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/widgets/runs/1', details_url: 'https://ci.example/1' },
      { name: 'deploy-preview', status: 'completed', conclusion: 'timed_out', html_url: null, details_url: 'https://ci.example/2' },
      { name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/widgets/runs/3' },
      { name: 'e2e', status: 'in_progress', conclusion: null },
    ];
    const statuses = [
      { context: 'ci/lint', state: 'error', target_url: null },
      { context: 'ci/coverage', state: 'success', target_url: 'https://coverage.example' },
    ];
    expect(commitChecks(runs, statuses)).toEqual({
      state: 'red',
      failed: [
        { name: 'build', url: 'https://github.com/acme/widgets/runs/1' },
        { name: 'deploy-preview', url: 'https://ci.example/2' },
        { name: 'ci/lint', url: null },
      ],
    });
  });

  test('name none while none failed', () => {
    expect(commitChecks([{ name: 'e2e', status: 'queued' }], [{ context: 'ci/lint', state: 'success' }])).toEqual({ state: 'pending', failed: [] });
    expect(commitChecks([], [])).toEqual({ state: 'none', failed: [] });
  });
});
