// The Claude subscription's usage windows as the CLI's `/usage` reads them
// (ADR 0008): display only. A `rate_limit_event` comes only when a window's
// status changes, and rarely says how much of it is spent, so without asking
// the windows read unknown.
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { UsageReading, UsageWindowKind } from '../usage/usage.ts';

// The usage windows as `/usage` reads them: null when the account has none,
// as with an API key.
export type SubscriptionWindows = SDKControlGetUsageResponse['rate_limits'];

// A window's reading as a run reports it: the factory notes when it was seen.
export type WindowReading = Omit<UsageReading, 'seenAt'>;

// The windows `/usage` reads that the factory keeps snapshots of.
const SUBSCRIPTION_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const satisfies readonly UsageWindowKind[];

// A share of a window spent, held to 0 to 1.
export function shareSpent(fraction: number): number {
  return Math.min(Math.max(fraction, 0), 1);
}

// The usage windows as readings: each window `/usage` reads a share of (in
// percent). It says nothing of a window's status.
export function readingsOf(windows: SubscriptionWindows): WindowReading[] {
  return SUBSCRIPTION_WINDOWS.flatMap((window) => {
    const reading = windows?.[window];
    if (typeof reading?.utilization !== 'number') return [];
    const resetsAt = reading.resets_at ? Date.parse(reading.resets_at) : NaN;
    return [{ window, status: null, spent: shareSpent(reading.utilization / 100), resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }];
  });
}

// How often the windows are read, across runs: they share the account.
export const READ_EVERY_MS = 5 * 60_000;
// How soon a read that failed is tried again.
export const RETRY_MS = 60_000;

// Reads the usage windows at most every `READ_EVERY_MS` across runs. A read
// that fails is tried again after `RETRY_MS`; one whose readings no run kept
// (its run ended first) may be tried again at once.
export function subscriptionWindowReader(now: () => number = Date.now) {
  let readAt = -Infinity;
  return {
    // Reads the windows with `read`, unless read lately, and hands the
    // readings to `keep`, which says whether it kept them.
    read(read: () => Promise<SubscriptionWindows>, keep: (readings: WindowReading[]) => boolean): void {
      const at = now();
      if (at - readAt < READ_EVERY_MS) return;
      const before = readAt;
      readAt = at;
      read().then(
        (windows) => {
          if (!keep(readingsOf(windows))) readAt = before;
        },
        () => {
          readAt = at - READ_EVERY_MS + RETRY_MS;
        },
      );
    },
  };
}
