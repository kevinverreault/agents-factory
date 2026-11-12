// Seam 2 harness: an in-memory protocol client that serves scripted snapshots,
// patches, conversation events and replies, and records the commands the TUI
// sends, the conversations it opens and leaves, and the runs whose output it
// follows and stops following.
import type { ConversationEvent } from '../executor/executor.ts';
import type { ConversationListener, FactoryConnection, StateListener } from '../protocol/client.ts';
import { applyPatch, type FactoryState, type PatchOp } from '../protocol/factory-state.ts';
import type { Command, Reply } from '../protocol/protocol.ts';

export class FakeConnection implements FactoryConnection {
  readonly protocolVersion = 11;
  readonly sent: Command[] = [];
  readonly conversed: string[] = [];
  readonly left: string[] = [];
  readonly followed: string[] = [];
  readonly unfollowed: string[] = [];
  private readonly conversations = new Map<string, Set<ConversationListener>>();
  private state: FactoryState | null = null;
  private readonly listeners = new Set<StateListener>();
  private readonly closeListeners = new Set<() => void>();
  private readonly replies = new Map<Command['type'], Reply>();
  private readonly held = new Map<Command['type'], ((reply: Reply) => void)[]>();
  closed = false;

  send(command: Command): Promise<Reply> {
    this.sent.push(command);
    const waiting = this.held.get(command.type);
    if (waiting) return new Promise((answer) => waiting.push(answer));
    return Promise.resolve(this.replies.get(command.type) ?? { ok: true });
  }

  // Every later command of this type waits, as on a daemon still busy with
  // it, until the returned function answers them all with its reply.
  holdReplies(type: Command['type']): (reply: Reply) => void {
    const waiting: ((reply: Reply) => void)[] = [];
    this.held.set(type, waiting);
    return (reply) => {
      this.held.delete(type);
      for (const answer of waiting.splice(0)) answer(reply);
    };
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
    return this.listen(runId, listener, this.left);
  }

  follow(runId: string, listener: ConversationListener): () => void {
    this.followed.push(runId);
    return this.listen(runId, listener, this.unfollowed);
  }

  private listen(runId: string, listener: ConversationListener, leaves: string[]): () => void {
    const listeners = this.conversations.get(runId) ?? new Set();
    this.conversations.set(runId, listeners.add(listener));
    return () => {
      listeners.delete(listener);
      leaves.push(runId);
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
