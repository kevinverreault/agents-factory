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
};

export function factoryPaths(env: NodeJS.ProcessEnv = process.env): FactoryPaths {
  const home = env.AGENTS_FACTORY_HOME ?? defaultHome(env);
  return {
    home,
    pipePath: pipePathFor(home),
    tokenPath: join(home, 'daemon.token'),
    storePath: join(home, 'factory.sqlite'),
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
