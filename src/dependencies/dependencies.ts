// A worktree's dependencies (ADR 0010): a task worktree is a fresh checkout,
// without the gitignored `node_modules` of the operator's clone, so before
// a run starts on the host the factory installs them from the worktree's
// lockfile. A run that finds none goes looking in the operator's clone,
// where every call leaves its worktree and asks the operator again (T16).
// The install is from the lockfile only, as the L1 allow list lets a run do
// itself, so it fetches what the project pinned and changes nothing it
// depends on.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AFK_UNSET } from '../guards/run-git.ts';

export interface Dependencies {
  // Installs the worktree's dependencies from its lockfile unless they are
  // installed already. Resolves the command it ran, or null when the
  // worktree has no lockfile or nothing to install. Throws a
  // `DependenciesError` when the install fails.
  install(worktree: string): Promise<string | null>;
}

export class DependenciesError extends Error {}

// How a worktree's dependencies install: the package manager's command, and
// the file it writes once an install has finished, whose absence means none
// has, or one was cut short.
export type Install = { command: string[]; installed: string };

// The install the worktree's lockfile calls for, if it has one. A worktree
// with several takes the first: npm's, then pnpm's, then Yarn's.
export function installFor(worktree: string): Install | null {
  const has = (file: string) => existsSync(join(worktree, file));
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) {
    return { command: ['npm', 'ci', '--no-audit', '--no-fund'], installed: join('node_modules', '.package-lock.json') };
  }
  if (has('pnpm-lock.yaml')) return { command: ['pnpm', 'install', '--frozen-lockfile'], installed: join('node_modules', '.modules.yaml') };
  if (has('yarn.lock')) {
    // Yarn 2 and later read `.yarnrc.yml`, and may install no `node_modules`.
    return has('.yarnrc.yml')
      ? { command: ['yarn', 'install', '--immutable'], installed: join('.yarn', 'install-state.gz') }
      : { command: ['yarn', 'install', '--frozen-lockfile'], installed: join('node_modules', '.yarn-integrity') };
  }
  return null;
}

// How long an install may take before the factory gives up on it.
const INSTALL_TIMEOUT_MS = 15 * 60_000;
// How much of a failed install's output its error keeps: the end, where the reason is.
const OUTPUT_TAIL = 2_000;

// Installs with the package manager on the PATH, in the daemon's
// environment less the credentials an AFK run goes without: the project's
// install scripts run as a test script would, and get no more.
export function lockfileDependencies(): Dependencies {
  return {
    install(worktree) {
      const install = installFor(worktree);
      if (!install || existsSync(join(worktree, install.installed))) return Promise.resolve(null);
      const env = { ...process.env };
      for (const name of AFK_UNSET) delete env[name];
      const text = install.command.join(' ');
      // npm, pnpm and Yarn are `.cmd` scripts on Windows, which only a shell
      // runs, given the whole line. Its words are the factory's own, never a repo's.
      const shell = process.platform === 'win32';
      const [program, ...args] = shell ? [text] : install.command;
      return new Promise((done, fail) =>
        execFile(
          program!,
          args,
          { cwd: worktree, env, shell, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            if (!error) return done(text);
            const output = `${stderr}`.trim() || `${stdout}`.trim() || error.message;
            fail(new DependenciesError(`\`${text}\` failed: ${output.slice(-OUTPUT_TAIL)}`));
          },
        ),
      );
    },
  };
}
