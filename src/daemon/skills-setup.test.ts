// Seam 1: the skill set's per-repo setup through the client protocol. Each
// repository says whether the docs its skills expect (the issue tracker and
// triage labels under `docs/agents/`) are on its base branch on origin, as
// last checked; "Set up now" is the `setup` preset, one HITL run of
// `/factory:setup-matt-pocock-skills`; and once that setup lands, the check
// finds it.
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const widgets = resolve('/clones/widgets');
const SETUP = {
  'docs/agents/issue-tracker.md': '# Issue tracker: GitHub\n',
  'docs/agents/triage-labels.md': '# Triage Labels\n',
};

// A factory attached to, with a clone of acme/widgets that has the App
// installed but isn't registered yet.
async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  factory.git.addClone(widgets, { originUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main' });
  factory.github.install('acme/widgets');
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

// Origin's main gets `files`, and the clone fetches it, as registering a
// fresh clone would find it.
async function onMain(factory: TestFactory, files: Record<string, string>): Promise<void> {
  factory.git.advanceOrigin(widgets, 'main', files);
  await factory.git.fetch(widgets, 'main');
}

const MISSING =
  'acme/widgets has no setup for the skill set on main (docs/agents/issue-tracker.md, docs/agents/triage-labels.md): ' +
  'its skills won’t find the issue tracker and labels they expect.';

describe('whether a repository has the skill set’s setup', () => {
  test('a repository without it shows that it’s missing, and which docs', async () => {
    const { factory, operator, tui } = await attached();

    expect(await operator.send({ type: 'registerRepo', path: widgets })).toMatchObject({
      ok: true,
      value: { skills: { present: false, checkedAt: factory.clock.now(), reason: MISSING } },
    });
    expect((await tui.until((state) => 'acme/widgets' in state.repositories)).repositories['acme/widgets']!.skills).toEqual({
      present: false,
      checkedAt: factory.clock.now(),
      reason: MISSING,
    });
  });

  test('one with only some of the docs names those it lacks', async () => {
    const { factory, operator } = await attached();
    await onMain(factory, { 'docs/agents/issue-tracker.md': '# Issue tracker: GitHub\n' });

    expect(await operator.send({ type: 'registerRepo', path: widgets })).toMatchObject({
      ok: true,
      value: { skills: { present: false, reason: expect.stringContaining('on main (docs/agents/triage-labels.md):') } },
    });
  });

  test('one whose base branch has the docs shows it present', async () => {
    const { factory, operator } = await attached();
    await onMain(factory, SETUP);

    expect(await operator.send({ type: 'registerRepo', path: widgets })).toMatchObject({
      ok: true,
      value: { skills: { present: true, checkedAt: factory.clock.now() } },
    });
  });

  test('every repository is checked again when the daemon starts', async () => {
    const { factory, operator } = await attached();
    await operator.send({ type: 'registerRepo', path: widgets });
    await onMain(factory, SETUP);

    await factory.restart();

    const tui = watch(await factory.attach());
    await tui.until((state) => state.repositories['acme/widgets']?.skills?.present === true);
  });
});

// acme/widgets registered without the setup, and T1 its `setup` task, as
// "Set up now" launches it.
async function settingUp(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const attachedFactory = await attached();
  const { operator, tui } = attachedFactory;
  await operator.send({ type: 'registerRepo', path: widgets });
  expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'setup' })).toEqual({ ok: true, value: { taskId: 'T1' } });
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  return attachedFactory;
}

describe('Set up now', () => {
  test('launches a HITL `setup` task in the repository: one run of the setup skill', async () => {
    const { factory, tui } = await settingUp();

    expect(tui.state().tasks.T1).toMatchObject({ repo: 'acme/widgets', mode: 'HITL', stage: 'setup', preset: { name: 'setup' } });
    expect(factory.executor.started).toMatchObject([{ taskId: 'T1', mode: 'HITL', cwd: tui.state().tasks.T1!.worktree, firstMessage: '/factory:setup-matt-pocock-skills' }]);
  });
});

describe('after the setup lands', () => {
  // The setup task's branch, with the docs it wrote, merged into main on origin.
  function landed(factory: TestFactory, tui: Watched): void {
    const { worktree, branch } = tui.state().tasks.T1!;
    for (const path of Object.keys(SETUP)) factory.git.editFile(worktree!, path);
    factory.git.commitAll(worktree!);
    factory.git.merge(widgets, branch!, 'main');
  }

  test('checking again fetches the base branch and reports the setup present', async () => {
    const { factory, operator, tui } = await settingUp();
    landed(factory, tui);
    factory.clock.advance(60_000);

    expect(await operator.send({ type: 'checkSkills', repo: 'acme/widgets' })).toEqual({
      ok: true,
      value: { present: true, checkedAt: factory.clock.now() },
    });
    await tui.until((state) => state.repositories['acme/widgets']?.skills?.present === true);
  });

  test('marking the setup task done checks again', async () => {
    const { factory, operator, tui } = await settingUp();
    await operator.send({ type: 'advanceStage', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.label === 'In review');
    landed(factory, tui);

    expect(await operator.send({ type: 'markDone', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.repositories['acme/widgets']?.skills?.present === true);
  });

  test('a base branch that can’t be fetched says the check failed, and why', async () => {
    const { factory, operator } = await settingUp();
    factory.git.cutOffOrigin(widgets, 'fatal: unable to access origin');

    expect(await operator.send({ type: 'checkSkills', repo: 'acme/widgets' })).toEqual({
      ok: true,
      value: {
        present: false,
        checkedAt: factory.clock.now(),
        reason: 'The factory couldn’t check the skill set’s setup in acme/widgets: couldn’t fetch main from origin (fatal: unable to access origin).',
      },
    });
  });

  test('only a registered repository is checked', async () => {
    const { operator } = await attached();

    expect(await operator.send({ type: 'checkSkills', repo: 'acme/gadgets' })).toEqual({ ok: false, reason: 'acme/gadgets is not registered.' });
  });
});
