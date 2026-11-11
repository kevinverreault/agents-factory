import { join, resolve } from 'node:path';
import { SandboxError, type Container, type ContainerListing, type ContainerSpec, type ImageListing, type Sandbox } from '../sandbox/sandbox.ts';
import type { FakeGit } from './fake-git.ts';

type FakeContainer = { spec: ContainerSpec; running: boolean; denied: string[]; image: string };

// The image this factory version builds, once a container needs it.
export const CURRENT_IMAGE = 'agents-factory-sandbox:current';

// Containers that exist only in memory: each one's clone is a clone of the
// fake git, sharing its commits, at `clonePathOf(task)`, with its working
// tree at `workdirOf(task)`, where a test edits and commits as the run's
// agent would. It records what it was asked to do, in order.
export class FakeSandbox implements Sandbox {
  // `prepare T1`, `stop T1`, `restart T1`, `start T1`, `bringOut T1`, `remove T1`.
  readonly calls: string[] = [];
  // Each spec a container was prepared with.
  readonly prepared: ContainerSpec[] = [];
  private readonly containers = new Map<string, FakeContainer>();
  // The images the factory built, each with whether another factory home's
  // containers use it.
  private readonly built = new Map<string, { usedElsewhere: boolean }>();
  private failures = new Map<string, string>();
  private unlistable: string | null = null;

  constructor(private readonly git: FakeGit) {}

  clonePathOf(taskId: string): string {
    return resolve(`/containers/${taskId}`);
  }

  workdirOf(taskId: string): string {
    return join(this.clonePathOf(taskId), 'work');
  }

  // Whether the task's container runs, or null when it has none.
  state(taskId: string): 'running' | 'stopped' | null {
    const container = this.containers.get(taskId);
    return container ? (container.running ? 'running' : 'stopped') : null;
  }

  // Each call of `op` (such as `prepare` or `bringOut`) fails with a
  // `SandboxError` saying `reason` from now on, or works again (null).
  fail(op: 'prepare' | 'bringOut' | 'start' | 'stop' | 'restart' | 'remove', reason: string | null): void {
    if (reason === null) this.failures.delete(op);
    else this.failures.set(op, reason);
  }

  // A request from the task's running container to `host`, as its run
  // would make one through its egress proxy: whether it got through. One
  // its spec's egress doesn't allow is denied, and listed.
  request(taskId: string, host: string): boolean {
    const container = this.containers.get(taskId);
    if (!container?.running) throw new Error(`${taskId} has no running container.`);
    if (container.spec.egress.includes(host)) return true;
    if (!container.denied.includes(host)) container.denied.push(host);
    return false;
  }

  // Listing fails with `reason` from now on, as with Docker unreachable, or works again.
  failList(reason: string | null): void {
    this.unlistable = reason;
  }

  // The daemon before this one made the task's container, now in `state`,
  // from `image`.
  leave(spec: ContainerSpec, state: 'running' | 'stopped', image = CURRENT_IMAGE): void {
    this.git.cloneOf(spec.clonePath, this.clonePathOf(spec.taskId), this.workdirOf(spec.taskId), spec.branch);
    this.containers.set(spec.taskId, { spec, running: state === 'running', denied: [], image });
    if (!this.built.has(image)) this.built.set(image, { usedElsewhere: false });
  }

  // An older factory version built `image`, which no container of this
  // factory home uses, but maybe another's.
  leaveImage(image: string, { usedElsewhere = false } = {}): void {
    this.built.set(image, { usedElsewhere });
  }

  // Whether the image is there.
  hasImage(image: string): boolean {
    return this.built.has(image);
  }

  async prepare(spec: ContainerSpec): Promise<Container> {
    this.record('prepare', spec.taskId);
    this.prepared.push(spec);
    let container = this.containers.get(spec.taskId);
    if (!container) {
      this.git.cloneOf(spec.clonePath, this.clonePathOf(spec.taskId), this.workdirOf(spec.taskId), spec.branch);
      this.containers.set(spec.taskId, (container = { spec, running: false, denied: [], image: CURRENT_IMAGE }));
      if (!this.built.has(CURRENT_IMAGE)) this.built.set(CURRENT_IMAGE, { usedElsewhere: false });
    }
    container.spec = spec;
    container.running = true;
    container.denied = [];
    const path = this.clonePathOf(spec.taskId);
    const host = this.git.branchTip(spec.clonePath, spec.branch)!;
    const mine = this.git.branchTip(path, spec.branch)!;
    if (this.git.inHistory(mine, host)) this.git.moveBranch(path, spec.branch, host);
    else if (!this.git.inHistory(host, mine)) throw new SandboxError(`${spec.branch} has commits in the container and on the host that the other lacks.`);
    for (const branch of spec.branches) this.git.moveBranch(path, branch, this.git.branchTip(spec.clonePath, branch)!);
    return this.handle(spec);
  }

  async start(taskId: string): Promise<void> {
    this.record('start', taskId);
    const container = this.containers.get(taskId);
    if (container) container.running = true;
  }

  async stop(taskId: string): Promise<void> {
    this.record('stop', taskId);
    const container = this.containers.get(taskId);
    if (container) container.running = false;
  }

  async restart(taskId: string): Promise<boolean> {
    this.record('restart', taskId);
    const container = this.containers.get(taskId);
    if (!container) return false;
    container.running = true;
    return true;
  }

  async bringOut(taskId: string, worktreePath: string, branch: string): Promise<string> {
    this.record('bringOut', taskId);
    const container = this.containers.get(taskId);
    if (!container?.running) throw new SandboxError(`${taskId}’s container isn’t running.`);
    const { branch: checkedOut } = await this.git.worktreeState(worktreePath);
    if (checkedOut !== branch) throw new SandboxError(`${branch} isn’t checked out in ${worktreePath}.`);
    const { clonePath } = container.spec;
    const host = this.git.branchTip(clonePath, branch)!;
    const mine = this.git.branchTip(this.clonePathOf(taskId), branch)!;
    if (this.git.inHistory(host, mine)) {
      this.git.moveBranch(clonePath, branch, mine);
      return mine;
    }
    if (this.git.inHistory(mine, host)) return host;
    throw new SandboxError(`${branch} has commits in the container and on the host that the other lacks.`);
  }

  async remove(taskId: string): Promise<void> {
    this.record('remove', taskId);
    if (!this.containers.delete(taskId)) return;
    this.git.removeClone(this.clonePathOf(taskId));
  }

  async list(): Promise<ContainerListing[]> {
    if (this.unlistable) throw new SandboxError(this.unlistable);
    return [...this.containers].map(([taskId, { running }]) => ({ taskId, running }));
  }

  async images(): Promise<ImageListing[]> {
    if (this.unlistable) throw new SandboxError(this.unlistable);
    return [...this.built]
      .filter(([, { usedElsewhere }]) => !usedElsewhere)
      .map(([image]) => ({ image, current: image === CURRENT_IMAGE, usedBy: [...this.containers].filter(([, container]) => container.image === image).map(([taskId]) => taskId) }))
      .sort((a, b) => a.image.localeCompare(b.image));
  }

  async removeImage(image: string): Promise<void> {
    this.record('removeImage', image);
    const user = [...this.containers].find(([, container]) => container.image === image);
    if (user) throw new SandboxError(`Error response from daemon: conflict: unable to remove ${image}: container ${user[0]} is using it`);
    this.built.delete(image);
  }

  private record(op: string, taskId: string): void {
    this.calls.push(`${op} ${taskId}`);
    const failure = this.failures.get(op);
    if (failure) throw new SandboxError(failure);
  }

  private handle(spec: ContainerSpec): Container {
    const container = this.containers.get(spec.taskId)!;
    return {
      taskId: spec.taskId,
      workdir: this.workdirOf(spec.taskId),
      plugin: spec.plugin === null ? null : '/opt/factory/plugin',
      lspPlugin: '/opt/factory/lsp',
      checks: this.git,
      git: () => Promise.reject(new Error('The fake sandbox runs no git command.')),
      deniedHosts: async () => [...container.denied],
      spawn: () => {
        throw new Error('The fake sandbox spawns no process.');
      },
    };
  }
}
