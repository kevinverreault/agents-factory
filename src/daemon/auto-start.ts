// The TUI's way in (ADR 0002): attach to the running daemon, or start one
// detached and retry until it answers. A daemon on another protocol, left
// running from another build, is refused: its replies can't be trusted to
// mean what this build reads them as. The TUI offers to restart it now or
// when idle instead, through the daemon verbs every version keeps.
import { fileURLToPath } from 'node:url';
import { connect, HandshakeRefused, isNoDaemon, type Endpoint, type FactoryConnection } from '../protocol/client.ts';
import { PROTOCOL_VERSION, type Command } from '../protocol/protocol.ts';
import { spawnDetached } from './spawn-detached.ts';

const RETRY_MS = 100;

// The running daemon speaks another protocol version than this build.
export class VersionSkew extends HandshakeRefused {
  readonly daemonVersion: number;
  constructor(daemonVersion: number) {
    super(
      `The running daemon speaks protocol ${daemonVersion} and this agents-factory speaks ${PROTOCOL_VERSION}. ` +
        'Open agents-factory to restart it now or when idle, or stop it with `agents-factory daemon stop`, then try again.',
    );
    this.daemonVersion = daemonVersion;
  }
}

// When a daemon of another version restarts: now, its active AFK runs
// requeued and losing their in-flight turn, or once no run is active.
export type RestartWhen = 'now' | 'idle';

export async function connectOrStart(
  endpoint: Endpoint,
  startDaemon: () => void = startDetachedDaemon,
  { timeoutMs = 10_000 } = {},
): Promise<FactoryConnection> {
  let started = false;
  const giveUpAt = Date.now() + timeoutMs;
  for (;;) {
    let connection: FactoryConnection;
    try {
      connection = await connect(endpoint);
    } catch (error) {
      if (!isNoDaemon(error)) throw error;
      if (!started) {
        started = true;
        startDaemon();
      } else if (Date.now() >= giveUpAt) {
        throw new Error(`The daemon did not start within ${timeoutMs} ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      continue;
    }
    if (connection.protocolVersion === PROTOCOL_VERSION) return connection;
    connection.close();
    throw new VersionSkew(connection.protocolVersion);
  }
}

// Restarts the daemon of another version (ADR 0002): it stops gracefully,
// now or once no run is active, and this build's daemon is started and
// attached to. While it waits, `onWaiting` hears how many runs are active.
export async function restartDaemon(
  skew: VersionSkew,
  when: RestartWhen,
  endpoint: Endpoint,
  startDaemon: () => void = startDetachedDaemon,
  { onWaiting, timeoutMs }: { onWaiting?: (activeRuns: number) => void; timeoutMs?: number } = {},
): Promise<FactoryConnection> {
  let old: FactoryConnection;
  try {
    old = await connect(endpoint);
  } catch (error) {
    // It stopped meanwhile.
    if (isNoDaemon(error)) return connectOrStart(endpoint, startDaemon, { timeoutMs });
    throw error;
  }
  if (old.protocolVersion === PROTOCOL_VERSION) return old;
  const closed = new Promise<void>((resolve) => old.onClose(resolve));
  const command: Command = when === 'now' ? { type: 'daemon.stop' } : { type: 'daemon.restartWhenIdle' };
  const reply = await old.send(command);
  const activeRuns = reply.ok ? (reply.value as { activeRuns?: unknown } | undefined)?.activeRuns : undefined;
  if (!reply.ok || (when === 'idle' && typeof activeRuns !== 'number')) {
    old.close();
    throw new HandshakeRefused(
      reply.ok
        ? 'The running daemon is too old to restart when idle: restart it now, or stop it later with `agents-factory daemon stop`.'
        : `The running daemon (protocol ${skew.daemonVersion}) refused to restart: ${reply.reason}`,
    );
  }
  if (typeof activeRuns === 'number' && activeRuns > 0) onWaiting?.(activeRuns);
  await closed;
  return connectOrStart(endpoint, startDaemon, { timeoutMs });
}

// Detached, hidden and with no inherited stdio, so it outlives the terminal.
// It inherits the environment, `AGENTS_FACTORY_HOME` included.
export function startDetachedDaemon(): void {
  spawnDetached(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url))]);
}
