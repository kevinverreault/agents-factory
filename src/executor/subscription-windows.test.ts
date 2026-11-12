import { describe, expect, test } from 'vitest';
import { READ_EVERY_MS, readingsOf, RETRY_MS, subscriptionWindowReader, type SubscriptionWindows, type WindowReading } from './subscription-windows.ts';

describe('the usage windows, as the CLI’s /usage reads them', () => {
  test('each window reads as spent (0 to 1) and when it resets, in ms, saying nothing of its status', () => {
    expect(
      readingsOf({
        five_hour: { utilization: 42, resets_at: '2026-11-12T15:00:00Z' },
        seven_day: { utilization: 7.5, resets_at: '2026-11-16T09:30:00.000Z' },
        seven_day_opus: { utilization: 100, resets_at: '2026-11-16T09:30:00Z' },
      }),
    ).toEqual([
      { window: 'five_hour', status: null, spent: 0.42, resetsAt: Date.UTC(2026, 10, 12, 15) },
      { window: 'seven_day', status: null, spent: 0.075, resetsAt: Date.UTC(2026, 10, 16, 9, 30) },
      { window: 'seven_day_opus', status: null, spent: 1, resetsAt: Date.UTC(2026, 10, 16, 9, 30) },
    ]);
  });

  test('a window it doesn’t read gives nothing', () => {
    expect(readingsOf({ five_hour: null })).toEqual([]);
  });

  test('a window read without a share gives nothing', () => {
    expect(readingsOf({ seven_day: { utilization: null, resets_at: '2026-11-16T09:30:00Z' } })).toEqual([]);
  });

  test('a window read without a reset reads as spent, resetting when unknown', () => {
    expect(readingsOf({ seven_day_sonnet: { utilization: 3, resets_at: null } })).toEqual([{ window: 'seven_day_sonnet', status: null, spent: 0.03, resetsAt: null }]);
  });

  test('an account without usage windows gives nothing', () => {
    expect(readingsOf(null)).toEqual([]);
  });
});

describe('reading the usage windows across runs', () => {
  const WINDOWS: SubscriptionWindows = { five_hour: { utilization: 10, resets_at: '2026-11-12T15:00:00Z' } };
  // Lets the read's promise settle.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function reader() {
    let clock = 0;
    const reads: string[] = [];
    const kept: WindowReading[][] = [];
    const windows = subscriptionWindowReader(() => clock);
    return {
      advance: (ms: number) => (clock += ms),
      reads,
      kept,
      read: (by: string, outcome: 'answers' | 'fails' = 'answers', keeps = true) =>
        windows.read(
          () => {
            reads.push(by);
            return outcome === 'answers' ? Promise.resolve(WINDOWS) : Promise.reject(new Error('unsupported'));
          },
          (readings) => {
            if (keeps) kept.push(readings);
            return keeps;
          },
        ),
    };
  }

  test('the windows are read once every few minutes, whichever run asks', async () => {
    const { advance, reads, kept, read } = reader();
    read('R1');
    await settle();
    read('R2');
    advance(READ_EVERY_MS - 1);
    read('R1');
    advance(1);
    read('R2');
    await settle();
    expect(reads).toEqual(['R1', 'R2']);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toEqual([{ window: 'five_hour', status: null, spent: 0.1, resetsAt: Date.UTC(2026, 10, 12, 15) }]);
  });

  test('a read that fails is tried again a minute later, not after the full wait', async () => {
    const { advance, reads, read } = reader();
    read('R1', 'fails');
    await settle();
    advance(RETRY_MS - 1);
    read('R1');
    advance(1);
    read('R1');
    expect(reads).toEqual(['R1', 'R1']);
  });

  test('readings no run kept, its run having ended, leave the next run free to read at once', async () => {
    const { reads, kept, read } = reader();
    read('R1', 'answers', false);
    await settle();
    read('R2');
    await settle();
    expect(reads).toEqual(['R1', 'R2']);
    expect(kept).toHaveLength(1);
  });
});
