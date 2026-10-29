import { spawn, type ChildProcess } from 'node:child_process';

// Starts a process that outlives its parent and the parent's terminal window:
// no console, no inherited stdio, its own process group, not kept alive by us.
export function spawnDetached(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  return child;
}
