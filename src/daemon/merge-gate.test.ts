// Seam 1: the merge gate's config (ADR 0014), through the client protocol.
// The operator's merge-gate.yaml in the factory home, and its section for
// the task's repository, override the built-in defaults; the result is
// frozen onto the task at launch when it starts AFK, or at its handoff, so
// editing the file never changes the gate under a task in flight. An
// invalid file refuses the launch or handoff with the reason. The frozen
// merge method is the one the factory merges with.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { relayHook } from '../hooks/relay.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const MINUTE = 60_000;

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

async function attached(): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

// The operator writes their merge-gate.yaml.
function writeGate({ factory }: Factory, content: string): void {
  writeFileSync(factory.paths.mergeGatePath, content);
}

const fullAuto: LaunchCommand = { type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: 'Add a logout button.', autonomy: 'L3', mergePolicy: 'unattended' };

async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

// Works the implement, review and PR body runs from the run `first` on, then
// lets the gate through on a repo with no checks.
async function throughMerge({ factory, tui }: Factory, first = 1, taskId = 'T1'): Promise<void> {
  await started(factory, first);
  const workdir = factory.sandbox.workdirOf(taskId);
  factory.git.editFile(workdir, 'src/logout.ts', 'export {};\n');
  factory.git.commitAll(workdir);
  factory.executor.report(`R${first}`, { type: 'runCompleted' });
  await started(factory, first + 1);
  factory.executor.report(`R${first + 1}`, { type: 'runCompleted' });
  await started(factory, first + 2);
  factory.executor.report(`R${first + 2}`, { type: 'prBodyWritten', body: 'Adds a logout button.' });
  factory.executor.report(`R${first + 2}`, { type: 'runCompleted' });
  await tui.until((state) => state.tasks[taskId]?.gate?.checks === 'none');
  factory.clock.advance(2 * MINUTE);
  await tui.until((state) => state.tasks[taskId]?.label === 'Done');
}

const mergeMethods = ({ factory }: Factory) => factory.github.prWrites.filter(({ action }) => action === 'merge').map(({ method }) => method);

describe('the merge method', () => {
  test('with no merge-gate.yaml, the factory merges with a merge commit', async () => {
    const launched = await attached();
    await launched.operator.send(fullAuto);
    await throughMerge(launched);
    expect(mergeMethods(launched)).toEqual(['merge']);
  });

  test('a repository’s section setting squash makes the factory squash that repository’s PRs', async () => {
    const launched = await attached();
    writeGate(launched, 'merge_method: rebase\nrepositories:\n  acme/widgets:\n    merge_method: squash\n');
    await launched.operator.send(fullAuto);
    await throughMerge(launched);
    expect(mergeMethods(launched)).toEqual(['squash']);
  });
});

describe('freezing the config', () => {
  test('a task starting AFK freezes it at launch: editing the file afterwards, even into an invalid one, changes nothing under it', async () => {
    const launched = await attached();
    writeGate(launched, 'merge_method: squash\n');
    expect(await launched.operator.send(fullAuto)).toEqual({ ok: true, value: { taskId: 'T1' } });
    writeGate(launched, 'merge_method: rebase\n');
    await started(launched.factory, 1);
    writeGate(launched, 'merge_method: fast-forward\n');
    await throughMerge(launched);
    expect(mergeMethods(launched)).toEqual(['squash']);
  });

  test('a spec task’s ticket tasks inherit the config it froze', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    factory.github.addIssue('acme/widgets#10');
    factory.github.addIssue('acme/widgets#11', { parent: 'acme/widgets#10', labels: ['ready-for-agent'] });
    writeGate(launched, 'merge_method: squash\n');
    expect(await operator.send({ ...fullAuto, prompt: '', issues: ['#10'] })).toEqual({ ok: true, value: { taskId: 'T1' } });
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R1');
    expect(tui.state().tasks.T2).toMatchObject({ kind: 'ticket', specTask: 'T1', mergePolicy: 'unattended' });
    writeGate(launched, 'merge_method: rebase\n');
    await throughMerge(launched, 1, 'T2');
    expect(mergeMethods(launched)).toEqual(['squash']);
  });

  test('a task starting HITL freezes it at its handoff, as the file then stands', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    writeGate(launched, 'merge_method: rebase\n');
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'quick', prompt: 'Add a logout button.', quick: true });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.tasks.T1?.handoff !== null);
    factory.executor.report('R1', { type: 'briefWritten', brief: { goal: 'Add a logout button.', decided: [], doneWhen: [], outOfScope: [], links: [] } });
    factory.executor.report('R1', { type: 'turnEnded' });
    const { brief, tier, maxTurns } = (await tui.until((state) => !!state.tasks.T1?.handoff?.brief)).tasks.T1!.handoff!;
    const confirm = { type: 'handoff', taskId: 'T1', brief: brief!, continueAs: 'resume', autonomy: 'L3', mergePolicy: 'unattended', tier, maxTurns } as const;

    writeGate(launched, 'merge_method: [');
    expect(await operator.send(confirm)).toEqual({
      ok: false,
      reason: expect.stringMatching(new RegExp(`^The merge gate config at ${factory.paths.mergeGatePath.replace(/[\\.]/g, '\\$&')} isn’t YAML: `)),
    });
    expect(tui.state().tasks.T1).toMatchObject({ mode: 'HITL' });

    writeGate(launched, 'merge_method: squash\n');
    expect(await operator.send(confirm)).toEqual({ ok: true });
    writeGate(launched, 'merge_method: rebase\n');
    await throughMerge(launched, 2);
    expect(mergeMethods(launched)).toEqual(['squash']);
  });
});

describe('a handoff a crash cut short', () => {
  test('keeps the config it froze when the next daemon finishes it, whatever the file says by then', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    writeGate(launched, 'merge_method: squash\n');
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'quick', prompt: 'Add a logout button.', quick: true });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    // The HITL run writes a file for the handoff to commit, which journals it first.
    const { sessionId, cwd } = factory.executor.started[0]!;
    factory.git.editFile(cwd!, 'GLOSSARY.md');
    const write = { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(cwd!, 'GLOSSARY.md') } };
    await relayHook(JSON.stringify({ ...write, tool_response: '' }), factory.paths);
    await tui.until((state) => Object.keys(state.artifacts).length > 0);
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.tasks.T1?.handoff !== null);
    factory.executor.report('R1', { type: 'briefWritten', brief: { goal: 'Add a logout button.', decided: [], doneWhen: [], outOfScope: [], links: [] } });
    factory.executor.report('R1', { type: 'turnEnded' });
    const { brief, tier, maxTurns } = (await tui.until((state) => !!state.tasks.T1?.handoff?.brief)).tasks.T1!.handoff!;

    const crashed = factory.crashAt('git', 'commit', 'before');
    void operator.send({ type: 'handoff', taskId: 'T1', brief: brief!, continueAs: 'resume', autonomy: 'L3', mergePolicy: 'unattended', tier, maxTurns });
    await crashed;
    await factory.crash();
    writeGate(launched, 'merge_method: rebase\n');
    await factory.startDaemon();
    const again = await factory.attach();
    const restarted: Factory = { factory, operator: again, tui: watch(again) };
    await restarted.tui.until((state) => state.tasks.T1?.mode === 'AFK');

    await throughMerge(restarted, 2);
    expect(mergeMethods(restarted)).toEqual(['squash']);
  });
});

describe('an invalid file', () => {
  test('refuses a launch starting AFK with the reason, and nothing launches', async () => {
    const launched = await attached();
    writeGate(launched, 'repositories:\n  acme/widgets:\n    merge_method: fast-forward\n');
    expect(await launched.operator.send(fullAuto)).toEqual({
      ok: false,
      reason: `The merge gate config at ${launched.factory.paths.mergeGatePath} is invalid: repositories.acme/widgets.merge_method must be merge, squash or rebase, not fast-forward.`,
    });
    expect(launched.tui.state().tasks).toEqual({});
    expect(launched.factory.executor.started).toEqual([]);
  });

  test('doesn’t hold up a task starting HITL, which reads it at its handoff', async () => {
    const launched = await attached();
    writeGate(launched, 'merge_method: fast-forward\n');
    expect(await launched.operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'quick', prompt: 'Add a logout button.', quick: true })).toEqual({
      ok: true,
      value: { taskId: 'T1' },
    });
  });
});
