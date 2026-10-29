import type { Clock } from '../daemon/clock.ts';

// A controllable clock: time moves only when a test advances it, and every
// tick due on the way fires in order.
export class FakeClock implements Clock {
  private time: number;
  private readonly timers = new Set<{ due: number; ms: number; tick: () => void }>();

  constructor(start = Date.UTC(2026, 9, 29, 9, 0, 0)) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  every(ms: number, tick: () => void): () => void {
    const timer = { due: this.time + ms, ms, tick };
    this.timers.add(timer);
    return () => void this.timers.delete(timer);
  }

  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a.due - b.due)[0];
      if (!next || next.due > until) break;
      this.time = next.due;
      next.due += next.ms;
      next.tick();
    }
    this.time = until;
  }
}
