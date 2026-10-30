// Where the factory keeps its things for one OS user. `AGENTS_FACTORY_HOME`
// moves all of it, pipe name included, which keeps test factories apart from
// the operator's own.
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

export type FactoryPaths = {
  home: string;
  pipePath: string;
  tokenPath: string;
  storePath: string;
  // The one global root every task worktree hangs under (ADR 0010).
  worktreeRoot: string;
  // The skill set pin and its built versions (ADR 0005).
  skillsLock: string;
  skillsRoot: string;
  // The operator's own workflow presets: the user scope.
  presetsDir: string;
};

export function factoryPaths(env: NodeJS.ProcessEnv = process.env): FactoryPaths {
  const home = env.AGENTS_FACTORY_HOME ?? defaultHome(env);
  // Kept short by default: Windows path limits bite deep in worktrees.
  const shortHome = env.AGENTS_FACTORY_HOME ?? join(homedir(), '.agent-factory');
  return {
    home,
    pipePath: pipePathFor(home),
    tokenPath: join(home, 'daemon.token'),
    storePath: join(home, 'factory.sqlite'),
    worktreeRoot: join(shortHome, 'worktrees'),
    skillsLock: join(shortHome, 'skills.lock'),
    skillsRoot: join(shortHome, 'skills'),
    presetsDir: join(shortHome, 'presets'),
  };
}

function defaultHome(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agents-factory');
  return join(homedir(), 'Library', 'Application Support', 'agents-factory');
}

// The pipe name is the single-instance lock: one daemon per factory home.
export function pipePathFor(home: string): string {
  if (process.platform !== 'win32') return join(home, 'daemon.sock');
  const hash = createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\agents-factory-${userInfo().username}-${hash}`;
}
