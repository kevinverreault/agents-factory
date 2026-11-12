import { describe, expect, test } from 'vitest';
import { snapshotsOfPlan } from './agent-sdk.ts';

describe('the plan’s usage windows, as the CLI’s /usage reads them', () => {
  test('each window reads as spent (0 to 1) and when it resets, in ms', () => {
    const snapshots = snapshotsOfPlan({
      five_hour: { utilization: 42, resets_at: '2026-11-12T15:00:00Z' },
      seven_day: { utilization: 7.5, resets_at: '2026-11-16T09:30:00.000Z' },
      seven_day_opus: { utilization: 100, resets_at: '2026-11-16T09:30:00Z' },
    });
    expect(snapshots).toEqual([
      { window: 'five_hour', status: 'allowed', spent: 0.42, resetsAt: Date.UTC(2026, 10, 12, 15) },
      { window: 'seven_day', status: 'allowed', spent: 0.075, resetsAt: Date.UTC(2026, 10, 16, 9, 30) },
      { window: 'seven_day_opus', status: 'rejected', spent: 1, resetsAt: Date.UTC(2026, 10, 16, 9, 30) },
    ]);
  });

  test('a window it doesn’t read, or reads without a share, gives nothing; nor do plan limits that don’t apply', () => {
    expect(snapshotsOfPlan({ five_hour: null, seven_day: { utilization: null, resets_at: null }, seven_day_sonnet: { utilization: 3, resets_at: null } })).toEqual([
      { window: 'seven_day_sonnet', status: 'allowed', spent: 0.03, resetsAt: null },
    ]);
    expect(snapshotsOfPlan(null)).toEqual([]);
  });
});
