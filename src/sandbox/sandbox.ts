// The Sandbox port (ADR 0007, ADR 0011): where an L2 task's runs execute.
// Each task has one container of its own, a child task included. It clones
// the task's host clone from a read-only mount, holds the task branch's
// commits between runs, and hands them back to the host task branch through
// a git bundle. Nothing in it can write anywhere else: no credential goes
// in, and the clone it came from is mounted read-only. The Docker adapter
// (`docker.ts`) is the real one; the port is shaped so Docker Sandboxes can
// replace it later.
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Git } from '../git/git.ts';

// What a task's container is made from.
export type ContainerSpec = {
  taskId: string;
  // The task's host clone, whose git directory alone is mounted read-only:
  // the container clones from it and fetches the task branch's new commits
  // from it.
  clonePath: string;
  // The task branch, which the container's clone has checked out.
  branch: string;
  // Other branches of the host clone the container's clone gets as local
  // branches, such as the task's awaited children's, which its run merges.
  branches: string[];
  // The skill set plugin's directory on the host, copied in read-only, or
  // null for a task that froze none.
  plugin: string | null;
  // A host directory mounted read-only at `RUN_DIR`: each run's git config,
  // hooks and gh config, which the daemon writes before the run starts.
  runDir: string;
  // A host directory mounted as the CLI's project directory for the
  // container's workdir: the session transcripts, which runs on the host
  // resume too.
  sessionsDir: string;
  // The hosts the container may reach (ADR 0007): its egress is denied
  // anywhere else. Each prepare sets them afresh.
  egress: string[];
};

// The hosts every L2 run may reach (ADR 0007): the Claude API its CLI runs
// on, GitHub's API and site for reading issues and PRs with the run's
// read-only bot token, and the npm registry for installs from the lockfile.
// A task's own hosts join them.
export const BUILT_IN_EGRESS: readonly string[] = ['api.anthropic.com', 'api.github.com', 'github.com', 'registry.npmjs.org'];

// The hosts a task's container may reach: the built-in ones, then the
// task's own that aren't among them.
export function egressFor(taskHosts: readonly string[]): string[] {
  return [...BUILT_IN_EGRESS, ...taskHosts.filter((host) => !BUILT_IN_EGRESS.includes(host))];
}

// Where the run's own git config, hooks and gh config are, in the container.
export const RUN_DIR = '/factory/run';

// The run's environment as the container sees it: each value naming a path
// in the host's `runDir` names the same path under `RUN_DIR`.
export function inRunDir(env: Record<string, string>, runDir: string): Record<string, string> {
  const root = runDir.replace(/[\\/]+$/, '');
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      const inside = value === root || value.startsWith(`${root}\\`) || value.startsWith(`${root}/`);
      return [key, inside ? `${RUN_DIR}${value.slice(root.length).replaceAll('\\', '/')}` : value];
    }),
  );
}

// A git command's outcome in the container's clone.
export type GitResult = { code: number; stdout: string; stderr: string };

// A task's container, running.
export type Container = {
  taskId: string;
  // The clone's working tree, in the container: the run's cwd.
  workdir: string;
  // The skill set plugin's directory, in the container, or null.
  plugin: string | null;
  // The git checks of an AFK run (ADR 0007), made on the container's clone,
  // at `workdir`.
  checks: Pick<Git, 'snapshot' | 'violations'>;
  // Runs git in the container's clone, as its non-root user.
  git(args: string[]): Promise<GitResult>;
  // The hosts outside its egress that the container tried to reach since it
  // was last prepared, each once, in the order first denied.
  deniedHosts(): Promise<string[]>;
  // Starts `command` in the container, as its non-root user, in `workdir`,
  // with exactly `env` set besides the image's own, its stdin and stdout piped.
  spawn(command: string, args: string[], options: { env: Record<string, string | undefined>; signal?: AbortSignal }): ChildProcessByStdio<Writable, Readable, null>;
};

// A container the factory made, by its task, and whether it runs.
export type ContainerListing = { taskId: string; running: boolean };

export interface Sandbox {
  // The task's container, running, with the host task branch's commits
  // fetched in as a fast-forward and `branches` brought up to date. Made
  // first, image and all, when the task has none. A container whose branch
  // is ahead of the host's keeps its commits. Throws a `SandboxError` when
  // it can't be made or started, or when its branch and the host's diverged.
  prepare(spec: ContainerSpec): Promise<Container>;
  // Starts the task's container, if it is stopped.
  start(taskId: string): Promise<void>;
  // Stops the task's container, if it runs: whatever runs in it dies, and
  // its clone stays.
  stop(taskId: string): Promise<void>;
  // Stops and starts the task's container, if it has one, and says whether
  // it did: a turn still running in it dies with every process it started,
  // and its clone stays.
  restart(taskId: string): Promise<boolean>;
  // Brings the commits on the container's task branch out to `branch` in
  // the host worktree at `worktreePath`, through a git bundle, as a
  // fast-forward, and returns the host branch's tip. The container must be
  // running. Throws a `SandboxError` when it isn't a fast-forward, or the
  // worktree has another branch checked out.
  bringOut(taskId: string, worktreePath: string, branch: string): Promise<string>;
  // Removes the task's container, clone and all, if it has one.
  remove(taskId: string): Promise<void>;
  // Every container the factory made.
  list(): Promise<ContainerListing[]>;
}

export class SandboxError extends Error {}
