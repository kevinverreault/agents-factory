// Seam 1: `factory gc` (ADR 0011). The operator asks for the leftovers that
// belong to no live task: worktrees under the worktree root, local and
// remote `factory/*` branches, the factory's containers and its older
// sandbox images. The daemon lists them with the leftover matcher, and
// deletes only those the operator ticked.
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { Leftover, LeftoversView } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const clone = resolve('/clones/widgets');

async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

// What a daemon that crashed mid-launch left: a worktree under the worktree
// root on a task branch the store never heard of.
async function crashDebris(factory: TestFactory, taskId: string): Promise<{ path: string; branch: string }> {
  const path = join(factory.paths.worktreeRoot, 'acme-widgets', taskId);
  const branch = `factory/${taskId}-lost-work`;
  await factory.git.addWorktree(clone, { path, branch, startPoint: 'origin/main' });
  return { path, branch };
}

async function leftovers(operator: FactoryConnection): Promise<LeftoversView> {
  const reply = await operator.send({ type: 'listLeftovers' });
  if (!reply.ok) throw new Error(reply.reason);
  return reply.value as LeftoversView;
}

describe('listing leftovers', () => {
  test('lists a worktree under the worktree root and its factory branch that belong to no task', async () => {
    const { factory, operator } = await attached();
    const { path, branch } = await crashDebris(factory, 'T7');

    expect(await leftovers(operator)).toEqual({
      leftovers: [
        { leftover: { kind: 'worktree', repo: 'acme/widgets', path, branch }, why: 'No task of the factory’s has it.' },
        { leftover: { kind: 'branch', repo: 'acme/widgets', branch }, why: 'No task of the factory’s has it.' },
      ],
      unlisted: [],
    });
  });

  test('never lists a live task’s worktree or branch, and lists the branch a cancelled task kept', async () => {
    const { factory, operator, tui } = await attached();
    await launch(operator, 'Add a logout button.');
    await launch(operator, 'Add a login button.');
    const state = await tui.until((state) => state.tasks.T2?.liveRunId !== null && !!state.tasks.T2?.worktree);
    factory.git.editFile(state.tasks.T2!.worktree!, 'src/login.ts');
    factory.git.commitAll(state.tasks.T2!.worktree!);

    expect(await operator.send({ type: 'cancel', taskId: 'T2', branch: 'keep' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T2?.label === 'Cancelled' && state.tasks.T2.cleanup === null);

    expect(await leftovers(operator)).toEqual({
      leftovers: [{ leftover: { kind: 'branch', repo: 'acme/widgets', branch: 'factory/T2-add-a-login-button' }, why: 'T2 is Cancelled.' }],
      unlisted: [],
    });
  });

  test('never lists the branch of a Done awaited child that its live parent is still to merge', async () => {
    const { factory, operator, tui } = await attached();
    await launch(operator, 'Add a logout button.');
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    await factory.executor.delegate('R1', { type: 'spawnChild', toolUseId: 'toolu_1', goal: 'Write the logout handler.' });
    const state = await tui.until((state) => !!state.tasks.T2?.liveRunId);
    factory.git.editFile(state.tasks.T2!.worktree!, 'src/logout.ts');
    factory.git.commitAll(state.tasks.T2!.worktree!);
    factory.executor.report(state.tasks.T2!.liveRunId!, { type: 'runCompleted', result: 'Done.' });
    await tui.until((state) => state.tasks.T2?.label === 'Done' && state.tasks.T2.transcripts !== null);
    expect(factory.git.branchTip(clone, `${state.tasks.T1!.branch}--c1`)).not.toBeNull();

    expect(await leftovers(operator)).toEqual({ leftovers: [], unlisted: [] });
  });

  test('lists origin’s factory branches that belong to no live task, but not a live task’s pushed branch', async () => {
    const { factory, operator, tui } = await attached();
    await launch(operator, 'Add a logout button.');
    const live = (await tui.until((state) => !!state.tasks.T1?.liveRunId)).tasks.T1!.branch!;
    factory.git.push(clone, live);
    const { path, branch } = await crashDebris(factory, 'T7');
    factory.git.push(clone, branch);
    await factory.git.removeWorktree(clone, path);
    await factory.git.deleteBranch(clone, branch);

    expect(await leftovers(operator)).toEqual({
      leftovers: [{ leftover: { kind: 'remote-branch', repo: 'acme/widgets', branch }, why: 'No task of the factory’s has it.' }],
      unlisted: [],
    });
  });

  test('an origin that can’t be reached is said so, and the clone’s own leftovers are still listed', async () => {
    const { factory, operator } = await attached();
    const { path, branch } = await crashDebris(factory, 'T7');
    factory.git.cutOffOrigin(clone, 'fatal: unable to access the remote');

    expect(await leftovers(operator)).toEqual({
      leftovers: [
        { leftover: { kind: 'worktree', repo: 'acme/widgets', path, branch }, why: 'No task of the factory’s has it.' },
        { leftover: { kind: 'branch', repo: 'acme/widgets', branch }, why: 'No task of the factory’s has it.' },
      ],
      unlisted: ['acme/widgets’s branches on origin couldn’t be read: fatal: unable to access the remote'],
    });
  });

  test('lists the containers of no live task and the older images no live task’s container uses, never the current image or one another factory home uses', async () => {
    const { factory, operator, tui } = await attached();
    await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'oauth-token');
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: '#39', autonomy: 'L2' });
    await tui.until((state) => !!state.tasks.T1?.liveRunId);
    const t1 = factory.sandbox.prepared[0]!;
    factory.sandbox.leave({ ...t1, taskId: 'T9' }, 'stopped', 'agents-factory-sandbox:old1');
    factory.sandbox.leaveImage('agents-factory-sandbox:old2');
    factory.sandbox.leaveImage('agents-factory-sandbox:old3', { usedElsewhere: true });

    expect(await leftovers(operator)).toEqual({
      leftovers: [
        { leftover: { kind: 'container', taskId: 'T9' }, why: 'No task of the factory’s has it. Its clone may hold commits that never came out.' },
        { leftover: { kind: 'image', image: 'agents-factory-sandbox:old1' }, why: 'An older sandbox image no live task’s container uses.' },
        { leftover: { kind: 'image', image: 'agents-factory-sandbox:old2' }, why: 'An older sandbox image no live task’s container uses.' },
      ],
      unlisted: [],
    });
  });

  test('Docker that can’t be reached is said so, and the clones’ leftovers are still listed', async () => {
    const { factory, operator } = await attached();
    const { path, branch } = await crashDebris(factory, 'T7');
    factory.sandbox.failList('Cannot connect to the Docker daemon.');

    const listed = await leftovers(operator);

    expect(listed.leftovers.map(({ leftover }) => leftover)).toEqual([
      { kind: 'worktree', repo: 'acme/widgets', path, branch },
      { kind: 'branch', repo: 'acme/widgets', branch },
    ]);
    expect(listed.unlisted).toEqual(['Docker couldn’t be reached, so containers and images weren’t looked at: Cannot connect to the Docker daemon.']);
  });
});

describe('deleting leftovers', () => {
  test('deletes only the ticked ones: the remote branch as the factory identity, and the rest stay listed', async () => {
    const { factory, operator } = await attached();
    const t6 = await crashDebris(factory, 'T6');
    const t7 = await crashDebris(factory, 'T7');
    const t8 = await crashDebris(factory, 'T8');
    factory.git.push(clone, t8.branch);
    await factory.git.removeWorktree(clone, t8.path);
    await factory.git.deleteBranch(clone, t8.branch);
    factory.sandbox.leave({ taskId: 'T9', clonePath: clone, branch: t7.branch, branches: [], plugin: null, runDir: '/run', sessionsDir: '/sessions', egress: [] }, 'stopped');
    factory.sandbox.leaveImage('agents-factory-sandbox:old');
    const ticked: Leftover[] = [
      { kind: 'worktree', repo: 'acme/widgets', path: t7.path, branch: t7.branch },
      { kind: 'branch', repo: 'acme/widgets', branch: t7.branch },
      { kind: 'remote-branch', repo: 'acme/widgets', branch: t8.branch },
      { kind: 'container', taskId: 'T9' },
    ];

    expect(await operator.send({ type: 'gc', leftovers: ticked })).toEqual({ ok: true, value: { deleted: ticked, failed: [] } });

    expect((await leftovers(operator)).leftovers.map(({ leftover }) => leftover)).toEqual([
      { kind: 'worktree', repo: 'acme/widgets', path: t6.path, branch: t6.branch },
      { kind: 'branch', repo: 'acme/widgets', branch: t6.branch },
      { kind: 'image', image: 'agents-factory-sandbox:old' },
    ]);
    expect(factory.git.originTip(clone, t8.branch)).toBeNull();
    expect(factory.github.branchDeletes).toEqual([{ repo: 'acme/widgets', branch: t8.branch, token: expect.objectContaining({ permissions: { contents: 'write', metadata: 'read' } }) }]);
    expect(factory.sandbox.state('T9')).toBeNull();
    expect(factory.sandbox.hasImage('agents-factory-sandbox:old')).toBe(true);
  });

  test('never deletes what belongs to a live task, even ticked', async () => {
    const { factory, operator, tui } = await attached();
    await launch(operator, 'Add a logout button.');
    const state = await tui.until((state) => !!state.tasks.T1?.liveRunId);
    const { worktree, branch } = state.tasks.T1!;
    const ticked: Leftover[] = [
      { kind: 'worktree', repo: 'acme/widgets', path: worktree!, branch: branch! },
      { kind: 'branch', repo: 'acme/widgets', branch: branch! },
    ];

    expect(await operator.send({ type: 'gc', leftovers: ticked })).toEqual({
      ok: true,
      value: { deleted: [], failed: ticked.map((leftover) => ({ leftover, reason: 'It isn’t a leftover now: a live task has it, or it is gone.' })) },
    });
    expect(await factory.git.worktrees(clone)).toHaveLength(1);
  });

  test('one that can’t be deleted says why, and the others are deleted', async () => {
    const { factory, operator } = await attached();
    const t6 = await crashDebris(factory, 'T6');
    const t7 = await crashDebris(factory, 'T7');
    const kept: Leftover = { kind: 'branch', repo: 'acme/widgets', branch: t6.branch };
    const gone: Leftover = { kind: 'worktree', repo: 'acme/widgets', path: t7.path, branch: t7.branch };

    const reply = await operator.send({ type: 'gc', leftovers: [kept, gone] });

    expect(reply).toEqual({
      ok: true,
      value: { deleted: [gone], failed: [{ leftover: kept, reason: `error: cannot delete branch '${t6.branch}' used by worktree at '${t6.path}'` }] },
    });
  });
});

// Launches an AFK task, whose run starts at once.
async function launch(operator: FactoryConnection, prompt: string): Promise<void> {
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt });
  if (!launched.ok) throw new Error(launched.reason);
}
