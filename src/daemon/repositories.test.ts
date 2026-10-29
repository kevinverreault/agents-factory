// Seam 1: registering repositories through the client protocol (ADR 0010).
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const widgets = resolve('/clones/widgets');

function addWidgetsClone(factory: TestFactory): void {
  factory.git.addClone(widgets, { originUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main' });
}

// A factory with acme/widgets registered from its clone at `widgets`.
async function registered(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const attachedFactory = await attached();
  addWidgetsClone(attachedFactory.factory);
  await attachedFactory.operator.send({ type: 'registerRepo', path: widgets });
  return attachedFactory;
}

describe('repo add', () => {
  test('registering a clone puts its repository in the factory-state snapshot', async () => {
    const { factory, operator, tui } = await attached();
    addWidgetsClone(factory);

    expect(await operator.send({ type: 'registerRepo', path: widgets })).toEqual({
      ok: true,
      value: { id: 'acme/widgets', path: widgets, baseBranch: 'main', defaultPreset: 'main-flow', missing: false },
    });

    const state = await tui.until((state) => 'acme/widgets' in state.repositories);
    expect(state.repositories['acme/widgets']).toEqual({
      id: 'acme/widgets',
      path: widgets,
      baseBranch: 'main',
      defaultPreset: 'main-flow',
      missing: false,
    });
  });

  test('a clone is registered by its GitHub owner/name, from any directory inside it and any form of origin URL', async () => {
    const { factory, operator } = await attached();
    factory.git.addClone(widgets, { originUrl: 'git@github.com:acme/widgets.git', defaultBranch: 'trunk' });
    factory.git.addClone(resolve('/clones/gadgets'), { originUrl: 'ssh://git@github.com/acme/gadgets', defaultBranch: 'main' });

    expect(await operator.send({ type: 'registerRepo', path: resolve(widgets, 'src/deep') })).toMatchObject({
      ok: true,
      value: { id: 'acme/widgets', path: widgets, baseBranch: 'trunk' },
    });
    expect(await operator.send({ type: 'registerRepo', path: resolve('/clones/gadgets') })).toMatchObject({
      ok: true,
      value: { id: 'acme/gadgets' },
    });
  });

  test('registering is refused, with a reason, for anything but a fresh GitHub clone', async () => {
    const { factory, operator, tui } = await attached();
    addWidgetsClone(factory);
    factory.git.addClone(resolve('/clones/local'), { originUrl: null, defaultBranch: null });
    factory.git.addClone(resolve('/clones/gitlab'), { originUrl: 'https://gitlab.com/acme/widgets.git', defaultBranch: 'main' });
    await operator.send({ type: 'registerRepo', path: widgets });

    expect(await operator.send({ type: 'registerRepo', path: resolve('/elsewhere') })).toEqual({
      ok: false,
      reason: `${resolve('/elsewhere')} is not inside a git clone.`,
    });
    expect(await operator.send({ type: 'registerRepo', path: resolve('/clones/local') })).toEqual({
      ok: false,
      reason: `The clone at ${resolve('/clones/local')} has no GitHub origin.`,
    });
    expect(await operator.send({ type: 'registerRepo', path: resolve('/clones/gitlab') })).toEqual({
      ok: false,
      reason: `The clone at ${resolve('/clones/gitlab')} has no GitHub origin.`,
    });
    expect(await operator.send({ type: 'registerRepo', path: widgets })).toEqual({
      ok: false,
      reason: `acme/widgets is already registered at ${widgets}.`,
    });
    expect(await operator.send({ type: 'registerRepo', path: 'clones/widgets' })).toEqual({
      ok: false,
      reason: 'The clone path must be absolute, not clones/widgets.',
    });
    expect(Object.keys(tui.state().repositories)).toEqual(['acme/widgets']);
  });

  test('a clone whose origin/HEAD is unset needs its base branch named', async () => {
    const { factory, operator } = await attached();
    factory.git.addClone(widgets, { originUrl: 'https://github.com/acme/widgets.git', defaultBranch: null });

    expect(await operator.send({ type: 'registerRepo', path: widgets })).toEqual({
      ok: false,
      reason:
        `The clone at ${widgets} doesn't say which branch is origin's default. ` +
        'Name the base branch, or run `git remote set-head origin --auto` in the clone.',
    });
    expect(await operator.send({ type: 'registerRepo', path: widgets, baseBranch: 'develop' })).toMatchObject({
      ok: true,
      value: { baseBranch: 'develop' },
    });
  });

  test('the base branch and default preset are the operator’s to set, and live in the factory’s store', async () => {
    const { factory, operator } = await attached();
    addWidgetsClone(factory);
    await operator.send({ type: 'registerRepo', path: widgets, baseBranch: 'release', defaultPreset: 'quick' });

    await factory.restart();

    const tui = watch(await factory.attach());
    expect((await tui.until(() => true)).repositories['acme/widgets']).toEqual({
      id: 'acme/widgets',
      path: widgets,
      baseBranch: 'release',
      defaultPreset: 'quick',
      missing: false,
    });
  });
});

describe('the clone a TUI started in', () => {
  test('the daemon names the repository of the clone holding a directory, or refuses with the reason', async () => {
    const { factory, operator } = await attached();
    addWidgetsClone(factory);

    expect(await operator.send({ type: 'inspectClone', path: resolve(widgets, 'src') })).toEqual({
      ok: true,
      value: { repo: 'acme/widgets', path: widgets },
    });
    expect(await operator.send({ type: 'inspectClone', path: resolve('/elsewhere') })).toEqual({
      ok: false,
      reason: `${resolve('/elsewhere')} is not inside a git clone.`,
    });
  });
});

describe('repo remove', () => {
  test('a task is launched in a registered repository only', async () => {
    const { operator } = await registered();

    expect(await operator.send({ type: 'createTask', title: 'Fix the login bug', mode: 'AFK', repo: 'acme/gadgets' })).toEqual({
      ok: false,
      reason: 'acme/gadgets is not registered.',
    });
    expect(await operator.send({ type: 'createTask', title: 'Fix the login bug', mode: 'AFK', repo: 'acme/widgets' })).toEqual({
      ok: true,
      value: { taskId: 'T1' },
    });
  });

  test('removing a repository is refused while it has unfinished tasks, and succeeds once they are Done or Cancelled', async () => {
    const { factory, operator, tui } = await registered();
    await operator.send({ type: 'createTask', title: 'Fix the login bug', mode: 'AFK', repo: 'acme/widgets', submit: true });
    await operator.send({ type: 'createTask', title: 'Settle the glossary', mode: 'HITL', repo: 'acme/widgets' });

    expect(await operator.send({ type: 'removeRepo', repo: 'acme/widgets' })).toEqual({
      ok: false,
      reason: 'acme/widgets has unfinished tasks (T1, T2). Finish or cancel them first.',
    });

    factory.executor.report('R1', { type: 'runCompleted' });
    await operator.send({ type: 'markDone', taskId: 'T1' });
    await operator.send({ type: 'cancel', taskId: 'T2' });

    expect(await operator.send({ type: 'removeRepo', repo: 'acme/widgets' })).toEqual({ ok: true });
    const state = await tui.until((state) => !('acme/widgets' in state.repositories));
    // Done and Cancelled tasks keep their history.
    expect(state.tasks.T1?.label).toBe('Done');
    expect(state.tasks.T2?.label).toBe('Cancelled');
    expect(await operator.send({ type: 'removeRepo', repo: 'acme/widgets' })).toEqual({
      ok: false,
      reason: 'acme/widgets is not registered.',
    });
  });

  test('a removed repository stays removed after a restart, and can be registered again', async () => {
    const { factory, operator } = await registered();
    await operator.send({ type: 'removeRepo', repo: 'acme/widgets' });

    await factory.restart();

    const again = await factory.attach();
    expect((await watch(again).until(() => true)).repositories).toEqual({});
    expect(await again.send({ type: 'registerRepo', path: widgets })).toMatchObject({ ok: true });
  });
});

describe('repo move', () => {
  const moved = resolve('/moved/widgets');

  test('moving re-points the repository at its clone’s new path, in the store, and its tasks’ worktrees work again', async () => {
    const { factory, operator, tui } = await registered();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me on the login flow' });
    const worktree = (await tui.until((state) => state.tasks.T1?.worktree != null)).tasks.T1!.worktree!;
    factory.git.moveClone(widgets, moved);
    expect(await factory.git.inspectClone(worktree)).toBeNull();

    expect(await operator.send({ type: 'moveRepo', path: resolve(moved, 'src') })).toEqual({
      ok: true,
      value: { id: 'acme/widgets', path: moved, baseBranch: 'main', defaultPreset: 'main-flow', missing: false },
    });

    expect((await tui.until((state) => state.repositories['acme/widgets']?.path === moved)).attentionQueue).toEqual([]);
    // The worktree belongs to the clone at its new path.
    expect(await factory.git.inspectClone(worktree)).toMatchObject({ path: moved });
    await factory.restart();
    const after = watch(await factory.attach());
    expect((await after.until(() => true)).repositories['acme/widgets']).toMatchObject({ path: moved, missing: false });
  });

  test('moving is refused, with a reason, unless the path holds a clone of a registered repository', async () => {
    const { factory, operator, tui } = await registered();
    factory.git.addClone(resolve('/clones/gadgets'), { originUrl: 'https://github.com/acme/gadgets.git', defaultBranch: 'main' });

    expect(await operator.send({ type: 'moveRepo', path: resolve('/elsewhere') })).toEqual({
      ok: false,
      reason: `${resolve('/elsewhere')} is not inside a git clone.`,
    });
    expect(await operator.send({ type: 'moveRepo', path: resolve('/clones/gadgets') })).toEqual({
      ok: false,
      reason: 'acme/gadgets is not registered.',
    });
    expect(await operator.send({ type: 'moveRepo', path: 'moved/widgets' })).toEqual({
      ok: false,
      reason: 'The clone path must be absolute, not moved/widgets.',
    });
    expect(tui.state().repositories['acme/widgets']?.path).toBe(widgets);
  });

  test('moving from inside a task’s worktree re-points the repository at the clone, not the worktree', async () => {
    const { factory, operator, tui } = await registered();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me on the login flow' });
    const worktree = (await tui.until((state) => state.tasks.T1?.worktree != null)).tasks.T1!.worktree!;

    expect(await operator.send({ type: 'moveRepo', path: worktree })).toMatchObject({ ok: true, value: { path: widgets } });
  });
});

describe('a missing clone', () => {
  const moved = resolve('/moved/widgets');
  const repoMissing = (requestId: string) => ({
    kind: 'attention',
    taskId: null,
    repo: 'acme/widgets',
    requestId,
    attention: 'repo-missing',
    holdsRun: false,
    reason: `The clone of acme/widgets is no longer at ${widgets}.`,
  });

  test('a moved clone raises exactly one repo-missing attention request, however many runs would start', async () => {
    const { factory, operator, tui } = await registered();
    for (const title of ['Fix the login bug', 'Fix the flaky test', 'Bump the SDK']) {
      await operator.send({ type: 'createTask', repo: 'acme/widgets', title, mode: 'AFK' });
    }

    factory.git.moveClone(widgets, moved);
    for (const taskId of ['T1', 'T2', 'T3']) expect(await operator.send({ type: 'submit', taskId })).toEqual({ ok: true });

    const state = await tui.until((state) => state.repositories['acme/widgets']?.missing === true);
    expect(state.attentionQueue).toEqual([repoMissing('A1')]);
    expect(['T1', 'T2', 'T3'].map((id) => state.tasks[id]?.label)).toEqual(['Queued', 'Queued', 'Queued']);
    expect(factory.executor.started).toEqual([]);
  });

  test('a missing repository’s runs can’t start: opening its conversation is refused with the reason', async () => {
    const { factory, operator, tui } = await registered();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Settle the glossary', mode: 'HITL', submit: true });

    factory.git.moveClone(widgets, moved);

    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'acme/widgets is missing, so its runs can’t start.',
    });
    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'acme/widgets is missing, so its runs can’t start.',
    });
    expect(tui.state().attentionQueue).toEqual([repoMissing('A1'), { kind: 'ready', taskId: 'T1' }]);
    expect(factory.executor.started).toEqual([]);
  });

  test('a clone that moved while the daemon was down is found missing at start, once', async () => {
    const { factory, operator } = await registered();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Fix the login bug', mode: 'AFK' });
    await factory.daemon().stop();
    factory.git.moveClone(widgets, moved);

    await factory.startDaemon();
    await factory.restart();

    const tui = watch(await factory.attach());
    const state = await tui.until((state) => state.repositories['acme/widgets']?.missing === true);
    expect(state.attentionQueue).toEqual([repoMissing('A1')]);
  });

  test('a clone back in place at the next start closes the request, and its queued tasks start', async () => {
    const { factory, operator, tui } = await registered();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Fix the login bug', mode: 'AFK' });
    factory.git.moveClone(widgets, moved);
    await operator.send({ type: 'submit', taskId: 'T1' });
    await tui.until((state) => state.attentionQueue.length === 1);

    factory.git.moveClone(moved, widgets);
    await factory.restart();

    const after = watch(await factory.attach());
    const state = await after.until((state) => state.tasks.T1?.label === 'Running');
    expect(state.repositories['acme/widgets']?.missing).toBe(false);
    expect(state.attentionQueue).toEqual([]);
    expect(factory.executor.started.map((run) => run.taskId)).toEqual(['T1']);
  });

  test('a path that now holds another repository’s clone counts as missing', async () => {
    const { factory, operator, tui } = await registered();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Fix the login bug', mode: 'AFK' });
    factory.git.moveClone(widgets, moved);
    factory.git.addClone(widgets, { originUrl: 'https://github.com/acme/gadgets.git', defaultBranch: 'main' });

    await operator.send({ type: 'submit', taskId: 'T1' });

    expect((await tui.until((state) => state.attentionQueue.length === 1)).attentionQueue).toEqual([repoMissing('A1')]);
  });

  test('moving a missing repository closes its request, and its queued tasks start', async () => {
    const { factory, operator, tui } = await registered();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Fix the login bug', mode: 'AFK' });
    factory.git.moveClone(widgets, moved);
    await operator.send({ type: 'submit', taskId: 'T1' });
    await tui.until((state) => state.attentionQueue.length === 1);

    expect(await operator.send({ type: 'moveRepo', path: moved })).toMatchObject({ ok: true, value: { path: moved, missing: false } });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(state.repositories['acme/widgets']).toMatchObject({ path: moved, missing: false });
    expect(state.attentionQueue).toEqual([]);
    expect(factory.executor.started.map((run) => run.taskId)).toEqual(['T1']);
  });

  test('removing a missing repository closes its request', async () => {
    const { factory } = await registered();
    factory.git.moveClone(widgets, moved);
    await factory.restart();
    const again = await factory.attach();
    await watch(again).until((state) => state.attentionQueue.length === 1);

    expect(await again.send({ type: 'removeRepo', repo: 'acme/widgets' })).toEqual({ ok: true });

    const state = await watch(again).until((state) => !('acme/widgets' in state.repositories));
    expect(state.attentionQueue).toEqual([]);
  });
});
