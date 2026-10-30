// Seam 1: workflow presets through the client protocol. Built-in, user and
// repo scopes resolve at launch, and a launched task freezes its preset.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { PresetsView } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const widgets = resolve('/clones/widgets');
const prompt = 'Grill me about the login flow.';

// Writes a user-scope preset, as the operator would in their editor.
function writeUserPreset(factory: TestFactory, name: string, content: string): string {
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  const path = join(factory.paths.presetsDir, `${name}.preset.yaml`);
  writeFileSync(path, content);
  return path;
}

// Pushes a repo-scope preset to origin's main, not yet fetched.
function pushRepoPreset(factory: TestFactory, name: string, content: string): string {
  return factory.git.advanceOrigin(widgets, 'main', { [`.agent-factory/presets/${name}.preset.yaml`]: content });
}

const oneStage = (skill: string) => `stages:\n  - { id: talk, kind: run, skill: ${skill}, args: "{{prompt}}", mode: HITL, model: haiku }\n`;

async function listPresets(operator: FactoryConnection): Promise<PresetsView> {
  const reply = await operator.send({ type: 'listPresets', repo: 'acme/widgets' });
  if (!reply.ok) throw new Error(reply.reason);
  return reply.value as PresetsView;
}

describe('the presets a launch card offers', () => {
  test('the built-ins are offered with the stages each can start at, and the repository’s default preset', async () => {
    const { operator } = await attached();

    const view = await listPresets(operator);

    expect(view.defaultPreset).toBe('main-flow');
    expect(view.warning).toBeNull();
    expect(view.presets.map((preset) => preset.name)).toEqual(['child', 'main-flow', 'quick', 'setup', 'wayfinder']);
    expect(view.presets.find((preset) => preset.name === 'main-flow')).toMatchObject({
      source: 'built-in',
      startStages: [
        { id: 'grill', mode: 'HITL', model: 'opus', needs: ['prompt'] },
        { id: 'tickets', mode: 'HITL', model: 'opus', needs: ['issues'] },
        { id: 'implement', mode: 'AFK', model: 'sonnet', needs: ['issues'] },
      ],
    });
  });

  test('user and repo presets join the list, the repo’s read from what origin’s base branch had when last fetched, and a broken one says why', async () => {
    const { factory, operator } = await attached();
    writeUserPreset(factory, 'spike', oneStage('grill-me'));
    writeUserPreset(factory, 'broken', 'stages:\n  - { id: a, kind: run, skill: x, mode: HITL, exit: when-done }\n');
    pushRepoPreset(factory, 'nightly', oneStage('triage'));

    expect((await listPresets(operator)).presets.map((preset) => preset.name)).not.toContain('nightly');
    await factory.git.fetch(widgets, 'main');

    const { presets } = await listPresets(operator);
    expect(presets.find((preset) => preset.name === 'spike')).toMatchObject({ source: 'user' });
    expect(presets.find((preset) => preset.name === 'nightly')).toMatchObject({ source: 'repo' });
    expect(presets.find((preset) => preset.name === 'broken')).toEqual({
      name: 'broken',
      source: 'user',
      error: `Preset broken (user, ${join(factory.paths.presetsDir, 'broken.preset.yaml')}): stage a: exit when-done is not an exit condition (run-completed, artifact:<kind>, tickets-closed, map-cleared).`,
    });
  });

  test('a default preset that no longer resolves falls back to main-flow, with a warning', async () => {
    const { operator, tui } = await attached();
    await operator.send({ type: 'removeRepo', repo: 'acme/widgets' });
    await operator.send({ type: 'registerRepo', path: widgets, defaultPreset: 'nightly' });

    const view = await listPresets(operator);

    expect(view.defaultPreset).toBe('main-flow');
    expect(view.warning).toBe('The default preset of acme/widgets, nightly, no longer resolves (There is no preset nightly.), so main-flow is picked instead.');
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt })).toMatchObject({ ok: true });
    expect((await tui.until((state) => state.tasks.T1 !== undefined)).tasks.T1?.preset).toMatchObject({ name: 'main-flow' });
  });
});

describe('launching from a preset', () => {
  test('a launch freezes the preset it resolved, with its source, content hash and the repo preset commit, and starts its first stage', async () => {
    const { factory, operator, tui } = await attached();
    const tip = factory.git.advanceOrigin(widgets, 'main');

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt })).toEqual({ ok: true, value: { taskId: 'T1' } });

    const { tasks } = await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    expect(tasks.T1).toMatchObject({
      mode: 'HITL',
      stage: 'grill',
      preset: { name: 'main-flow', source: 'built-in', hash: expect.stringMatching(/^[0-9a-f]{16}$/), repoCommit: tip },
    });
    expect(tasks.T1?.preset?.stages.map((stage) => stage.id)).toEqual(['grill', 'spec', 'tickets', 'implement', 'review', 'pr-body', 'open-pr']);
    expect(factory.executor.started).toMatchObject([{ runId: 'R1', firstMessage: `/factory:grill-with-docs ${prompt}`, model: 'claude-opus-5-5' }]);
  });

  test('a repo preset, freshly fetched at launch, wins over a user preset of the same name, which wins over the built-in', async () => {
    const { factory, operator, tui } = await attached();
    const userPath = writeUserPreset(factory, 'main-flow', oneStage('grill-me'));

    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', prompt });
    const tip = pushRepoPreset(factory, 'main-flow', oneStage('triage'));
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', prompt });

    const { tasks } = await tui.until((state) => state.tasks.T2 !== undefined);
    expect(tasks.T1?.preset).toMatchObject({ source: 'user', path: userPath, stages: [{ skill: 'grill-me' }] });
    expect(tasks.T2?.preset).toMatchObject({
      source: 'repo',
      path: '.agent-factory/presets/main-flow.preset.yaml',
      repoCommit: tip,
      stages: [{ skill: 'triage' }],
    });
    expect(factory.executor.started.map((run) => run.firstMessage)).toEqual([`/factory:grill-me ${prompt}`, `/factory:triage ${prompt}`]);
  });

  test('a launched task’s frozen preset is unchanged after its file is edited, while later launches pick up the edit', async () => {
    const { factory, operator, tui } = await attached();
    writeUserPreset(factory, 'spike', oneStage('grill-me'));
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'spike', prompt });
    const launched = (await tui.until((state) => state.tasks.T1 !== undefined)).tasks.T1!.preset;

    writeUserPreset(factory, 'spike', oneStage('grill-with-docs'));
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'spike', prompt });
    await factory.restart();

    const { tasks } = await watch(await factory.attach()).until((state) => state.tasks.T2 !== undefined);
    expect(tasks.T1?.preset).toEqual(launched);
    expect(tasks.T2?.preset?.stages).toMatchObject([{ skill: 'grill-with-docs' }]);
    expect(tasks.T2?.preset?.hash).not.toBe(launched?.hash);
  });

  test('a preset failing the schema, naming an unknown exit condition or missing is refused at launch with nothing left behind', async () => {
    const { factory, operator, tui } = await attached();
    const path = writeUserPreset(factory, 'nightly', 'stages:\n  - { id: implement, kind: loop, skill: implement, mode: AFK, exit: all-green }\n');
    writeUserPreset(factory, 'sloppy', 'stages:\n  - { id: implement, kind: run, skill: implement, mode: AFK, budget: 9000 }\n');

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'nightly', prompt })).toEqual({
      ok: false,
      reason: `Preset nightly (user, ${path}): stage implement: exit all-green is not an exit condition (run-completed, artifact:<kind>, tickets-closed, map-cleared).`,
    });
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'sloppy', prompt })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('stage implement: budget is not a stage field.'),
    });
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'deploy', prompt })).toEqual({
      ok: false,
      reason: 'There is no preset deploy.',
    });

    await operator.send({ type: 'daemon.status' });
    expect(tui.state().tasks).toEqual({});
    expect(await factory.git.worktrees(widgets)).toEqual([]);
    expect(factory.executor.started).toEqual([]);
  });
});

describe('starting at a stage', () => {
  test('main-flow started at implement with issue refs skips the HITL stages and is AFK from the first second', async () => {
    const { factory, operator, tui } = await attached();

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', issues: ['#12', 'acme/widgets#13'] })).toEqual({
      ok: true,
      value: { taskId: 'T1' },
    });

    const { tasks } = await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(tasks.T1).toMatchObject({ title: 'acme/widgets#12 acme/widgets#13', mode: 'AFK', autonomy: 'L1', stage: 'implement' });
    expect(factory.executor.started).toMatchObject([
      { runId: 'R1', mode: 'AFK', autonomy: 'L1', firstMessage: '/factory:implement acme/widgets#12 acme/widgets#13', model: 'claude-sonnet-5-5' },
    ]);
  });

  test('a first stage whose args need no launch input launches with none, titled after its preset', async () => {
    const { factory, operator, tui } = await attached();

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'setup' })).toEqual({ ok: true, value: { taskId: 'T1' } });

    const { tasks } = await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    expect(tasks.T1).toMatchObject({ title: 'setup', mode: 'HITL', stage: 'setup' });
    expect(factory.executor.started).toMatchObject([{ firstMessage: '/factory:setup-matt-pocock-skills' }]);
  });

  test('a stage the launch inputs can’t start, or that lacks the inputs it needs, is refused with nothing left behind', async () => {
    const { factory, operator, tui } = await attached();

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'review', prompt })).toEqual({
      ok: false,
      reason: 'main-flow can’t start at review: its args can’t be filled from a prompt or issue refs. It can start at grill, tickets or implement.',
    });
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'deploy', prompt })).toEqual({
      ok: false,
      reason: 'main-flow has no stage deploy.',
    });
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', prompt })).toEqual({
      ok: false,
      reason: 'Starting main-flow at implement needs issue refs.',
    });
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: '  \n ' })).toEqual({
      ok: false,
      reason: 'Starting main-flow at grill needs a prompt.',
    });
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', stage: 'implement', issues: ['twelve'] })).toEqual({
      ok: false,
      reason: 'twelve is not an issue ref (#12, owner/name#12 or an issue URL).',
    });

    await operator.send({ type: 'daemon.status' });
    expect(tui.state().tasks).toEqual({});
    expect(await factory.git.worktrees(widgets)).toEqual([]);
  });
});

describe('groups and model tier', () => {
  test('a task is tagged with the groups it launched with, and the operator’s tier overrides the stage’s', async () => {
    const { factory, operator, tui } = await attached();

    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt, groups: ['billing', ' sso ', 'billing', ''], tier: 'haiku' });

    const { tasks } = await tui.until((state) => state.tasks.T1 !== undefined);
    expect(tasks.T1?.groups).toEqual(['billing', 'sso']);
    expect(factory.executor.started).toMatchObject([{ model: 'claude-haiku-5-5' }]);
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt, tier: 'gpt' as never })).toEqual({
      ok: false,
      reason: 'gpt is not a model tier (opus, sonnet or haiku).',
    });
  });

  test('the factory state names the repository the operator last launched in', async () => {
    const { factory, operator, tui } = await attached();
    expect(tui.state().lastUsedRepo).toBeNull();
    factory.git.addClone(resolve('/clones/gadgets'), { originUrl: 'https://github.com/acme/gadgets.git', defaultBranch: 'main' });
    await operator.send({ type: 'registerRepo', path: resolve('/clones/gadgets') });

    await operator.send({ type: 'launchTask', repo: 'acme/gadgets', prompt });
    expect((await tui.until((state) => state.lastUsedRepo !== null)).lastUsedRepo).toBe('acme/gadgets');
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
    expect((await tui.until((state) => state.lastUsedRepo === 'acme/widgets')).lastUsedRepo).toBe('acme/widgets');
  });
});
