// Seam 2 harness: an in-memory protocol client that serves scripted snapshots,
// patches, conversation events and replies, and records the commands the TUI
// sends and the conversations it opens and leaves.
import type { ConversationEvent } from '../executor/executor.ts';
import type { ConversationListener, FactoryConnection, StateListener } from '../protocol/client.ts';
import { applyPatch, type FactoryState, type PatchOp } from '../protocol/factory-state.ts';
import type { Command, Reply } from '../protocol/protocol.ts';

export class FakeConnection implements FactoryConnection {
  readonly protocolVersion = 4;
  readonly sent: Command[] = [];
  readonly conversed: string[] = [];
  readonly left: string[] = [];
  private readonly conversations = new Map<string, Set<ConversationListener>>();
  private state: FactoryState | null = null;
  private readonly listeners = new Set<StateListener>();
  private readonly closeListeners = new Set<() => void>();
  private readonly replies = new Map<Command['type'], Reply>();
  closed = false;

  send(command: Command): Promise<Reply> {
    this.sent.push(command);
    return Promise.resolve(this.replies.get(command.type) ?? { ok: true });
  }

  // Every later command of this type gets `reply`.
  replyTo(type: Command['type'], reply: Reply): void {
    this.replies.set(type, reply);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    if (this.state) listener(this.state, null);
    return () => void this.listeners.delete(listener);
  }

  converse(runId: string, listener: ConversationListener): () => void {
    this.conversed.push(runId);
    const listeners = this.conversations.get(runId) ?? new Set();
    this.conversations.set(runId, listeners.add(listener));
    return () => {
      listeners.delete(listener);
      this.left.push(runId);
    };
  }

  serveConversation(runId: string, ...events: ConversationEvent[]): void {
    for (const event of events) for (const listener of this.conversations.get(runId) ?? []) listener(event);
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
