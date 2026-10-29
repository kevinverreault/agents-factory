// The clock port: wall time and ticks. Tests drive a controllable fake.
export interface Clock {
  now(): number;
  // Calls `tick` every `ms` until the returned function is called.
  every(ms: number, tick: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  every(ms, tick) {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
};
