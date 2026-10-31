// The daemon's entry point, started detached by the TUI (or by hand).
import { agentSdkExecutor } from '../executor/agent-sdk.ts';
import { gitCli } from '../git/git.ts';
import { routingTable } from '../models/routing-table.ts';
import { skillSetManager } from '../skills/skill-set.ts';
import { openStore } from '../store/store.ts';
import { systemClock } from './clock.ts';
import { DaemonAlreadyRunning, startDaemon } from './daemon.ts';
import { factoryPaths } from './paths.ts';

const paths = factoryPaths();
const store = openStore(paths.storePath);
try {
  const daemon = await startDaemon({
    ...paths,
    store,
    clock: systemClock,
    executor: agentSdkExecutor(),
    git: gitCli,
    skillSets: skillSetManager({ root: paths.skillsRoot, lockPath: paths.skillsLock }),
    routingTable: routingTable(paths.modelsTable),
  });
  await daemon.stopped;
} catch (error) {
  store.close();
  if (!(error instanceof DaemonAlreadyRunning)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
