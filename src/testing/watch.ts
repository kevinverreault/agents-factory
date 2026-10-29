import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState, PatchOp } from '../protocol/factory-state.ts';

export type Watched = {
  snapshot(): FactoryState | null;
  state(): FactoryState;
  patches: PatchOp[][];
  // Resolves with the first state (current or later) that satisfies `test`.
  until(test: (state: FactoryState) => boolean, timeoutMs?: number): Promise<FactoryState>;
};

// Subscribes to the factory state the way a TUI does and records what arrives.
export function watch(connection: FactoryConnection): Watched {
  let snapshot: FactoryState | null = null;
  let latest: FactoryState | null = null;
  const patches: PatchOp[][] = [];
  const waiters = new Set<() => void>();
  connection.subscribe((state, patch) => {
    if (patch) patches.push(patch);
    else snapshot ??= state;
    latest = state;
    for (const wake of waiters) wake();
  });
  return {
    snapshot: () => snapshot,
    state() {
      if (!latest) throw new Error('No snapshot has arrived yet.');
      return latest;
    },
    patches,
    until(test, timeoutMs = 2_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (latest && test(latest)) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve(latest);
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error('The factory state never reached the expected shape.'));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
  };
}
