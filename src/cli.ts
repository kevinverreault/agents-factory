#!/usr/bin/env node
// agents-factory: with no arguments, opens the TUI (starting the daemon if
// none is running). `daemon status` and `daemon stop` inspect and stop it.
import { createElement as h } from 'react';
import { render } from 'ink';
import { connectOrStart } from './daemon/auto-start.ts';
import { factoryPaths } from './daemon/paths.ts';
import { connect, isNoDaemon, type FactoryConnection } from './protocol/client.ts';
import type { DaemonStatus } from './protocol/protocol.ts';
import { App } from './tui/app.ts';

const USAGE = 'Usage: agents-factory [daemon status | daemon stop]';

async function main(args: string[]): Promise<number> {
  const paths = factoryPaths();
  if (args.length === 0) {
    const connection = await connectOrStart(paths);
    // Closing the TUI closes only this connection; the daemon keeps running.
    await render(h(App, { connection })).waitUntilExit();
    connection.close();
    return 0;
  }
  if (args[0] === 'daemon' && (args[1] === 'status' || args[1] === 'stop') && args.length === 2) {
    let connection: FactoryConnection;
    try {
      connection = await connect(paths);
    } catch (error) {
      if (!isNoDaemon(error)) throw error;
      console.log('The daemon is not running.');
      return args[1] === 'stop' ? 0 : 3;
    }
    const reply = await connection.send({ type: args[1] === 'status' ? 'daemon.status' : 'daemon.stop' });
    connection.close();
    if (!reply.ok) {
      console.error(reply.reason);
      return 1;
    }
    console.log(args[1] === 'status' ? describe(reply.value as DaemonStatus) : 'The daemon stopped.');
    return 0;
  }
  console.error(USAGE);
  return 2;
}

function describe(status: DaemonStatus): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    `The daemon is running (pid ${status.pid}, protocol ${status.protocolVersion}), up since ${new Date(status.startedAt).toISOString()}.`,
    `${plural(status.attachedTuis, 'TUI')} attached, ${plural(status.activeRuns, 'active run')}, ` +
      `${plural(status.suspendedRuns, 'suspended run')}, ${plural(status.queuedTasks, 'queued task')}.`,
  ].join('\n');
}

process.exitCode = await main(process.argv.slice(2));
