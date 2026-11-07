// The Sandbox port's contract, shared by the fake and the Docker adapter so
// the two can't drift apart.
import { describe, expect, test } from 'vitest';
import { SandboxError, type Container, type ContainerSpec, type Sandbox } from './sandbox.ts';

export type SandboxFixture = {
  sandbox: Sandbox;
  // A host clone with a worktree for the task, on its task branch, and a
  // spec for its container. Each call makes another task.
  task(taskId: string): Promise<{ spec: ContainerSpec; worktree: string }>;
  // Commits a change on the host task branch, in its worktree, and returns the new tip.
  commitOnHost(worktree: string): Promise<string>;
  // Cuts `branch` in the host clone from its task branch's tip, plus one commit, and returns its tip.
  branchOnHost(spec: ContainerSpec, branch: string): Promise<string>;
  // Commits a change on the task branch in the container's clone, and returns the new tip.
  commitInContainer(container: Container): Promise<string>;
  // A branch's tip in the host clone.
  hostTip(spec: ContainerSpec, branch: string): Promise<string>;
  // A branch's tip in the container's clone, which must be running.
  containerTip(container: Container, branch: string): Promise<string>;
  dispose(): Promise<void>;
};

export function describeSandboxContract(name: string, makeFixture: () => Promise<SandboxFixture>): void {
  async function withFixture(body: (fixture: SandboxFixture) => Promise<void>): Promise<void> {
    const fixture = await makeFixture();
    try {
      await body(fixture);
    } finally {
      await fixture.dispose();
    }
  }

  const running = (sandbox: Sandbox, taskId: string) => sandbox.list().then((all) => all.find((listing) => listing.taskId === taskId)?.running ?? null);

  describe(`${name}: the Sandbox contract`, () => {
    test('a prepared container runs, and its clone has the task branch at the host’s tip', () =>
      withFixture(async ({ sandbox, task, hostTip, containerTip }) => {
        const { spec } = await task('T1');

        const container = await sandbox.prepare(spec);

        expect(await running(sandbox, 'T1')).toBe(true);
        expect(await containerTip(container, spec.branch)).toBe(await hostTip(spec, spec.branch));
        const snapshot = await container.checks.snapshot(container.workdir);
        expect(snapshot).toMatchObject({ branch: spec.branch, head: await hostTip(spec, spec.branch) });
      }));

    test('commits made in the container come out to the host task branch through a bundle', () =>
      withFixture(async ({ sandbox, task, commitInContainer, hostTip }) => {
        const { spec, worktree } = await task('T1');
        const container = await sandbox.prepare(spec);
        await commitInContainer(container);
        const tip = await commitInContainer(container);

        expect(await sandbox.bringOut('T1', worktree, spec.branch)).toBe(tip);
        expect(await hostTip(spec, spec.branch)).toBe(tip);
        // Nothing new: the host stays where it is.
        expect(await sandbox.bringOut('T1', worktree, spec.branch)).toBe(tip);
      }));

    test('the host task branch’s new commits come into the container at the next prepare', () =>
      withFixture(async ({ sandbox, task, commitOnHost, containerTip }) => {
        const { spec, worktree } = await task('T1');
        await sandbox.prepare(spec);
        const tip = await commitOnHost(worktree);

        const container = await sandbox.prepare(spec);

        expect(await containerTip(container, spec.branch)).toBe(tip);
      }));

    test('the other branches the spec names come in as local branches, at the host’s tips', () =>
      withFixture(async ({ sandbox, task, branchOnHost, containerTip }) => {
        const { spec } = await task('T1');
        const child = await branchOnHost(spec, 'factory/T1--c1');

        const container = await sandbox.prepare({ ...spec, branches: ['factory/T1--c1'] });

        expect(await containerTip(container, 'factory/T1--c1')).toBe(child);
      }));

    test('a stopped container keeps its clone, commits not yet brought out included, and runs again once prepared', () =>
      withFixture(async ({ sandbox, task, commitInContainer, containerTip }) => {
        const { spec } = await task('T1');
        const tip = await commitInContainer(await sandbox.prepare(spec));

        await sandbox.stop('T1');
        expect(await running(sandbox, 'T1')).toBe(false);
        // Stopping a stopped container is no error.
        await sandbox.stop('T1');
        const again = await sandbox.prepare(spec);

        expect(await running(sandbox, 'T1')).toBe(true);
        expect(await containerTip(again, spec.branch)).toBe(tip);
      }));

    test('a restarted container runs, with its clone kept', () =>
      withFixture(async ({ sandbox, task, commitInContainer, containerTip, hostTip }) => {
        const { spec, worktree } = await task('T1');
        const container = await sandbox.prepare(spec);
        const tip = await commitInContainer(container);

        expect(await sandbox.restart('T1')).toBe(true);

        expect(await running(sandbox, 'T1')).toBe(true);
        expect(await containerTip(container, spec.branch)).toBe(tip);
        // A task with no container has nothing to restart.
        expect(await sandbox.restart('T9')).toBe(false);
        await sandbox.bringOut('T1', worktree, spec.branch);
        expect(await hostTip(spec, spec.branch)).toBe(tip);
      }));

    test('a stopped container starts again, and a started one is left running', () =>
      withFixture(async ({ sandbox, task }) => {
        const { spec } = await task('T1');
        await sandbox.prepare(spec);
        await sandbox.stop('T1');

        await sandbox.start('T1');
        await sandbox.start('T1');

        expect(await running(sandbox, 'T1')).toBe(true);
      }));

    test('a removed container is gone, and the next prepare clones afresh from the host', () =>
      withFixture(async ({ sandbox, task, commitInContainer, containerTip, hostTip }) => {
        const { spec } = await task('T1');
        await commitInContainer(await sandbox.prepare(spec));

        await sandbox.remove('T1');
        expect(await running(sandbox, 'T1')).toBeNull();
        // Removing it again is no error.
        await sandbox.remove('T1');
        const fresh = await sandbox.prepare(spec);

        expect(await containerTip(fresh, spec.branch)).toBe(await hostTip(spec, spec.branch));
      }));

    test('each task has a container of its own', () =>
      withFixture(async ({ sandbox, task, commitInContainer, containerTip, hostTip }) => {
        const first = await task('T1');
        const second = await task('T2');
        const one = await sandbox.prepare(first.spec);
        const two = await sandbox.prepare(second.spec);

        await commitInContainer(one);
        await sandbox.stop('T1');

        expect(await running(sandbox, 'T2')).toBe(true);
        expect(await containerTip(two, second.spec.branch)).toBe(await hostTip(second.spec, second.spec.branch));
      }));

    test('a task branch changed on both sides is refused, by prepare and by bringing it out', () =>
      withFixture(async ({ sandbox, task, commitInContainer, commitOnHost }) => {
        const { spec, worktree } = await task('T1');
        await commitInContainer(await sandbox.prepare(spec));
        await commitOnHost(worktree);

        await expect(sandbox.prepare(spec)).rejects.toBeInstanceOf(SandboxError);
        await sandbox.start('T1');
        await expect(sandbox.bringOut('T1', worktree, spec.branch)).rejects.toBeInstanceOf(SandboxError);
      }));
  });
}
