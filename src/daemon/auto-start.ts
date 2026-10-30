// The TUI's way in (ADR 0002): attach to the running daemon, or start one
// detached and retry until it answers. A daemon on another protocol, left
// running from another build, is refused: its replies can't be trusted to
// mean what this build reads them as.
import { fileURLToPath } from 'node:url';
import { connect, HandshakeRefused, isNoDaemon, type Endpoint, type FactoryConnection } from '../protocol/client.ts';
import { PROTOCOL_VERSION } from '../protocol/protocol.ts';
import { spawnDetached } from './spawn-detached.ts';

const RETRY_MS = 100;

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
    throw new HandshakeRefused(
      `The running daemon speaks protocol ${connection.protocolVersion} and this agents-factory speaks ${PROTOCOL_VERSION}. ` +
        'Stop it with `agents-factory daemon stop`, then try again.',
    );
  }
}

// Detached, hidden and with no inherited stdio, so it outlives the terminal.
// It inherits the environment, `AGENTS_FACTORY_HOME` included.
export function startDetachedDaemon(): void {
  spawnDetached(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url))]);
}
