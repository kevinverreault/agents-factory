// Seam 2 harness: an in-memory protocol client that serves scripted snapshots
// and patches, and records the commands the TUI sends.
import type { FactoryConnection, StateListener } from '../protocol/client.ts';
import { applyPatch, type FactoryState, type PatchOp } from '../protocol/factory-state.ts';
import type { Command, Reply } from '../protocol/protocol.ts';

export class FakeConnection implements FactoryConnection {
  readonly protocolVersion = 1;
  readonly sent: Command[] = [];
  private state: FactoryState | null = null;
  private readonly listeners = new Set<StateListener>();
  private readonly closeListeners = new Set<() => void>();
  closed = false;

  send(command: Command): Promise<Reply> {
    this.sent.push(command);
    return Promise.resolve({ ok: true });
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    if (this.state) listener(this.state, null);
    return () => void this.listeners.delete(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  close(): void {
    this.closed = true;
  }

  serveSnapshot(state: FactoryState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state, null);
  }

  servePatch(ops: PatchOp[]): void {
    this.state = applyPatch(this.state!, ops);
    for (const listener of this.listeners) listener(this.state, ops);
  }

  // The daemon went away.
  drop(): void {
    for (const listener of this.closeListeners) listener();
  }
}
