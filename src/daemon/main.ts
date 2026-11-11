// The daemon's entry point, started detached by the TUI (or by hand).
import { buildLspPlugin, hostTypeScriptServer } from '../code-intelligence/code-intelligence.ts';
import { lockfileDependencies } from '../dependencies/dependencies.ts';
import { agentSdkExecutor } from '../executor/agent-sdk.ts';
import { gitCli } from '../git/git.ts';
import { gitHubApi } from '../github/github.ts';
import { routingTable } from '../models/routing-table.ts';
import { osProcesses } from '../os/processes.ts';
import { dockerSandbox } from '../sandbox/docker.ts';
import { windowsCredentials } from '../secrets/secrets.ts';
import { SECURITY_PLUGIN } from '../security-guidance/security-guidance.ts';
import { skillSetManager } from '../skills/skill-set.ts';
import { openStore } from '../store/store.ts';
import { systemClock } from './clock.ts';
import { DaemonAlreadyRunning, startDaemon } from './daemon.ts';
import { factoryPaths } from './paths.ts';

const paths = factoryPaths();
const store = openStore(paths.storePath);
const processes = osProcesses();
try {
  const daemon = await startDaemon({
    ...paths,
    store,
    clock: systemClock,
    executor: agentSdkExecutor({ adopt: processes.adopt, lspPlugin: buildLspPlugin(paths.lspPlugin, hostTypeScriptServer()), securityPlugin: SECURITY_PLUGIN }),
    git: gitCli,
    github: gitHubApi(),
    sandbox: dockerSandbox({ namespace: paths.credentialPrefix }),
    secrets: windowsCredentials(paths.credentialPrefix),
    skillSets: skillSetManager({ root: paths.skillsRoot, lockPath: paths.skillsLock }),
    processes,
    dependencies: lockfileDependencies(),
    routingTable: routingTable(paths.modelsTable),
  });
  await daemon.stopped;
} catch (error) {
  store.close();
  if (!(error instanceof DaemonAlreadyRunning)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
