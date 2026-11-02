// The client half of the protocol, used by the TUI and the CLI.
import { readFile } from 'node:fs/promises';
import { connect as connectSocket, type Socket } from 'node:net';
import type { ConversationEvent } from '../executor/executor.ts';
import { applyPatch, type FactoryState, type PatchOp } from './factory-state.ts';
import { readMessages, send, type Command, type DaemonMessage, type Reply } from './protocol.ts';

export type StateListener = (state: FactoryState, patch: PatchOp[] | null) => void;
export type ConversationListener = (event: ConversationEvent) => void;

// What a TUI needs from the daemon. The TUI is tested against an in-memory
// fake of this interface (Seam 2).
export interface FactoryConnection {
  readonly protocolVersion: number;
  // Resolves with ok or a refusal carrying its reason.
  send(command: Command): Promise<Reply>;
  // Gets the snapshot, then the state after each patch (with that patch).
  subscribe(listener: StateListener): () => void;
  // Gets the run's conversation so far, then each live event.
  converse(runId: string, listener: ConversationListener): () => void;
  // The same, without opening the conversation: the run still waits for the
  // operator while only followers listen.
  follow(runId: string, listener: ConversationListener): () => void;
  onClose(listener: () => void): void;
  close(): void;
}

export type Endpoint = { pipePath: string; tokenPath: string };

export class HandshakeRefused extends Error {}

// Whether `connect` failed because no daemon is listening on the pipe.
export function isNoDaemon(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

export function connect({ pipePath, tokenPath }: Endpoint): Promise<FactoryConnection> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(pipePath);
    let protocolVersion = 0;
    let connection: Connection | null = null;
    socket.once('error', reject);
    socket.once('close', () => reject(new HandshakeRefused('The daemon closed the connection during the handshake.')));
    readMessages<DaemonMessage>(socket, (message) => {
      if (connection) return connection.receive(message);
      switch (message.type) {
        case 'hello':
          protocolVersion = message.protocolVersion;
          // The token is read only now: the daemon writes it before it speaks.
          readFile(tokenPath, 'utf8').then(
            (token) => send(socket, { type: 'auth', token: token.trim() }),
            (error: Error) => {
              socket.destroy();
              reject(new HandshakeRefused(`The daemon token can't be read: ${error.message}`));
            },
          );
          break;
        case 'welcome':
          connection = new Connection(socket, protocolVersion);
          socket.off('error', reject);
          socket.on('error', () => {});
          resolve(connection);
          break;
        case 'refused':
          socket.destroy();
          reject(new HandshakeRefused(message.reason));
          break;
      }
    });
  });
}

class Connection implements FactoryConnection {
  private nextId = 1;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private readonly listeners = new Set<StateListener>();
  // Each run's listeners, each with whether it only follows the run and the
  // events it has had.
  private readonly conversations = new Map<string, Map<ConversationListener, { follows: boolean; seen: Set<string> }>>();
  private state: FactoryState | null = null;
  private subscribed = false;
  private readonly socket: Socket;
  readonly protocolVersion: number;

  constructor(socket: Socket, protocolVersion: number) {
    this.socket = socket;
    this.protocolVersion = protocolVersion;
    socket.on('close', () => {
      for (const resolve of this.pending.values()) resolve({ ok: false, reason: 'The daemon connection closed.' });
      this.pending.clear();
    });
  }

  receive(message: DaemonMessage): void {
    switch (message.type) {
      case 'reply': {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve?.(
          message.ok
            ? { ok: true, value: message.value }
            : { ok: false, reason: message.reason, ...(message.confirm ? { confirm: message.confirm } : {}), ...(message.choose ? { choose: message.choose } : {}) },
        );
        break;
      }
      case 'snapshot':
        this.state = message.state;
        for (const listener of this.listeners) listener(this.state, null);
        break;
      case 'patch':
        if (!this.state) return;
        this.state = applyPatch(this.state, message.ops);
        for (const listener of this.listeners) listener(this.state, message.ops);
        break;
      case 'conversation':
        // Asking again replays the history: each listener gets an event once.
        for (const [listener, { seen }] of this.conversations.get(message.runId) ?? []) {
          if (seen.has(message.event.id)) continue;
          seen.add(message.event.id);
          listener(message.event);
        }
        break;
    }
  }

  send(command: Command): Promise<Reply> {
    if (this.socket.destroyed) return Promise.resolve({ ok: false, reason: 'The daemon connection closed.' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      send(this.socket, { type: 'command', id, command });
    });
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    if (this.state) listener(this.state, null);
    if (!this.subscribed) {
      this.subscribed = true;
      send(this.socket, { type: 'subscribe' });
    }
    return () => void this.listeners.delete(listener);
  }

  converse(runId: string, listener: ConversationListener): () => void {
    return this.listen(runId, listener, false);
  }

  follow(runId: string, listener: ConversationListener): () => void {
    return this.listen(runId, listener, true);
  }

  // The daemon holds one subscription per run: it is in the conversation
  // while any listener is, and asked again whenever that changes.
  private listen(runId: string, listener: ConversationListener, follows: boolean): () => void {
    let listeners = this.conversations.get(runId);
    if (!listeners) this.conversations.set(runId, (listeners = new Map()));
    const following = (all: typeof listeners) => [...all.values()].every((entry) => entry.follows);
    const before = listeners.size ? following(listeners) : null;
    listeners.set(listener, { follows, seen: new Set() });
    if (following(listeners) !== before) this.ask(runId, following(listeners));
    return () => {
      const was = following(listeners);
      if (!listeners.delete(listener) || this.conversations.get(runId) !== listeners) return;
      if (listeners.size === 0) {
        this.conversations.delete(runId);
        send(this.socket, { type: 'leaveConversation', runId });
      } else if (following(listeners) !== was) this.ask(runId, following(listeners));
    };
  }

  private ask(runId: string, follows: boolean): void {
    send(this.socket, { type: 'converse', runId, ...(follows ? { follow: true as const } : {}) });
  }

  onClose(listener: () => void): void {
    if (this.socket.destroyed) listener();
    else this.socket.once('close', listener);
  }

  close(): void {
    this.socket.end();
  }
}
