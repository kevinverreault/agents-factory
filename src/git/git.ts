// The Git port: what the daemon reads from the operator's clones. Tests drive
// a fake; `gitCli` runs the real `git`.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export type Clone = {
  // The clone's top level, absolute.
  path: string;
  // `origin`'s URL, or null when the clone has no `origin`.
  originUrl: string | null;
  // The branch `origin/HEAD` points at, or null when it isn't set.
  defaultBranch: string | null;
};

export interface Git {
  // The clone holding `path` (its top level or anywhere inside it), or null
  // when `path` isn't inside a clone.
  inspectClone(path: string): Promise<Clone | null>;
}

export const gitCli: Git = {
  async inspectClone(path) {
    const top = await git(path, 'rev-parse', '--show-toplevel');
    if (top === null) return null;
    const head = await git(top, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
    return {
      path: resolve(top),
      originUrl: await git(top, 'remote', 'get-url', 'origin'),
      defaultBranch: head?.startsWith('origin/') ? head.slice('origin/'.length) : null,
    };
  },
};

// The command's trimmed output, or null when it fails.
function git(cwd: string, ...args: string[]): Promise<string | null> {
  return new Promise((done) =>
    execFile('git', ['-C', cwd, ...args], { windowsHide: true }, (error, stdout) => done(error ? null : stdout.trim())),
  );
}
