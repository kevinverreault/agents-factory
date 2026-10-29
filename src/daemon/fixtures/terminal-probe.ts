// Operator probe for closing a Windows Terminal window: starts the daemon stub
// from this terminal, records the PIDs, and asks the operator to close the
// window. The contract test checks the daemon afterwards.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTuiStub } from './tui-stub.ts';

export const terminalProbeFile = join(tmpdir(), 'agents-factory-terminal-probe.json');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startTuiStub(terminalProbeFile);
  console.log('Daemon stub started. Close this Windows Terminal window with its close button,');
  console.log('then, in a new terminal, run: npm run test:contract -- src/daemon');
}
