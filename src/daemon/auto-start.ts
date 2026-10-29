// The TUI's way in (ADR 0002): attach to the running daemon, or start one
// detached and retry until it answers.
import { fileURLToPath } from 'node:url';
import { connect, isNoDaemon, type Endpoint, type FactoryConnection } from '../protocol/client.ts';
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
    try {
      return await connect(endpoint);
    } catch (error) {
      if (!isNoDaemon(error)) throw error;
      if (!started) {
        started = true;
        startDaemon();
      } else if (Date.now() >= giveUpAt) {
        throw new Error(`The daemon did not start within ${timeoutMs} ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

// Detached, hidden and with no inherited stdio, so it outlives the terminal.
// It inherits the environment, `AGENTS_FACTORY_HOME` included.
export function startDetachedDaemon(): void {
  spawnDetached(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url))]);
}
