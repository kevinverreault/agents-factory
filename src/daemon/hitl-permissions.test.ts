// Seam 1: a HITL run's permission card, through the client protocol. A HITL
// run acts as the operator, with every settings source loaded, so Claude Code
// lets most calls through itself. A call it still asks about goes to the same
// gate as an L1 run's: the factory's allow list, the operator's permissions
// file or the task's rules let it through without asking; anything else shows
// as a card in the conversation, never an attention request, answered as a
// permission request is: Allow once, for this task, always, or Deny with a note.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

// A HITL task in conversation, on the agent's turn.
async function conversing(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });
  await tui.until((state) => state.runs.R1?.turn === 'agent');
  return { factory, operator, tui };
}

// A HITL task whose run asked about `npm publish`.
async function carded() {
  const attached = await conversing();
  attached.factory.executor.askPermission('R1', bash('toolu_1', 'npm publish'));
  await attached.tui.until((state) => state.runs.R1?.permission != null);
  return attached;
}

// Resolves once every change sent before it has gone through the daemon.
async function settled(connection: FactoryConnection): Promise<void> {
  await connection.send({ type: 'daemon.status' });
}

const bash = (id: string, command: string) => ({ id, tool: 'Bash', input: { command } });

const minutes = (count: number) => count * 60_000;

function operatorRules(factory: TestFactory, yaml: string): void {
  mkdirSync(dirname(factory.paths.permissionsPath), { recursive: true });
  writeFileSync(factory.paths.permissionsPath, yaml);
}

describe('a HITL run’s tool call', () => {
  test('that the factory’s allow list or the operator’s permissions file covers runs without asking', async () => {
    const { factory, operator, tui } = await conversing();
    operatorRules(factory, 'allow:\n  - Bash(make *)\n');

    factory.executor.askPermission('R1', bash('toolu_1', 'npm test'));
    factory.executor.askPermission('R1', bash('toolu_2', 'make lint'));
    // As T29's grill read the skill set, out of the worktree.
    factory.executor.askPermission('R1', bash('toolu_3', 'cd ~/.agent-factory/skills/4a39e27d6f9e2bd4/skills && cat grilling/SKILL.md | head -60'));
    await settled(operator);

    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true }, toolu_2: { allow: true }, toolu_3: { allow: true } });
    expect(tui.state().runs.R1?.permission).toBeNull();
  });

  test('that no rule covers shows as a card on its run, raises no attention request, and waits on the operator', async () => {
    const { factory, tui } = await carded();

    const state = tui.state();
    expect(state.runs.R1?.permission).toEqual({
      id: 'toolu_1',
      tool: 'Bash',
      summary: 'npm publish',
      rule: 'Bash(npm publish)',
      proposed: [{ part: 'npm publish', rule: 'Bash(npm publish *)' }],
    });
    expect(state.runs.R1?.status).toBe('active');
    expect(state.tasks.T1?.state).toBe('running');
    expect(state.attentionQueue.filter((item) => item.kind === 'attention')).toEqual([]);
    // No TUI has the conversation open: it waits on the operator.
    expect(state.tasks.T1?.label).toBe('Ready for you');
    expect(factory.executor.verdicts('R1')).toEqual({});
  });

  test('asked while a card is open waits for its answer, then goes to the gate in turn', async () => {
    const { factory, operator, tui } = await carded();

    factory.executor.askPermission('R1', bash('toolu_2', 'docker build .'));
    factory.executor.askPermission('R1', bash('toolu_3', 'npm test'));
    await settled(operator);
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_3: { allow: true } });
    expect(tui.state().runs.R1?.permission?.id).toBe('toolu_1');

    await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'once' } });

    const state = await tui.until((state) => state.runs.R1?.permission?.id === 'toolu_2');
    expect(state.runs.R1?.permission?.summary).toBe('docker build .');
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true }, toolu_3: { allow: true } });
  });

  test('a card the turn ended without is dropped unanswered, with the calls waiting behind it', async () => {
    const { factory, operator, tui } = await carded();
    factory.executor.askPermission('R1', bash('toolu_2', 'docker build .'));
    await settled(operator);

    await operator.send({ type: 'interrupt', taskId: 'T1' });
    factory.executor.report('R1', { type: 'turnEnded' });

    const state = await tui.until((state) => state.runs.R1?.turn === 'operator');
    expect(state.runs.R1?.permission).toBeNull();
    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'once' } })).toEqual({
      ok: false,
      reason: 'T1 has no open attention request.',
    });
    await settled(operator);
    expect(tui.state().runs.R1?.permission).toBeNull();
    expect(factory.executor.verdicts('R1')).toEqual({});
  });

  test('a card left unanswered for 30 minutes parks the run', async () => {
    const { factory, tui } = await carded();

    factory.clock.advance(minutes(31));

    expect((await tui.until((state) => state.runs.R1?.status === 'ended')).runs.R1).toMatchObject({ outcome: 'parked' });
  });
});

describe('answering a HITL run’s permission card', () => {
  test('needs an allow or a deny with a note', async () => {
    const { operator } = await carded();
    const refusal = 'Allow it once, for this task or always, or deny it with a note for the agent.';
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: false, reason: refusal });
    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { deny: '  ' } })).toEqual({ ok: false, reason: refusal });
  });

  test('Allow once lets that call through and closes the card; the same call later asks again', async () => {
    const { factory, operator, tui } = await carded();

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'once' } })).toEqual({ ok: true });

    expect((await tui.until((state) => state.runs.R1?.permission === null)).tasks.T1?.label).toBe('In conversation');
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true } });

    factory.executor.askPermission('R1', bash('toolu_2', 'npm publish'));
    expect((await tui.until((state) => state.runs.R1?.permission != null)).runs.R1?.permission?.id).toBe('toolu_2');
  });

  test('Deny with a note refuses the call, and the agent reads the note', async () => {
    const { factory, operator, tui } = await carded();

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { deny: 'Publishing is the release job’s.' } })).toEqual({ ok: true });

    await tui.until((state) => state.runs.R1?.permission === null);
    expect(factory.executor.verdicts('R1')).toEqual({
      toolu_1: { allow: false, message: 'The operator denied this: Publishing is the release job’s.' },
    });
  });

  test('Allow for this task adds the rules, which then cover like calls without a card', async () => {
    const { factory, operator, tui } = await carded();

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'task' } })).toEqual({ ok: true });

    const state = await tui.until((state) => state.runs.R1?.permission === null);
    expect(state.tasks.T1?.allowRules).toEqual(['Bash(npm publish *)']);
    factory.executor.askPermission('R1', bash('toolu_2', 'npm publish --tag next'));
    await settled(operator);
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true }, toolu_2: { allow: true } });
    expect(tui.state().runs.R1?.permission).toBeNull();
  });

  test('Allow always adds the rules to the operator’s permissions file, and lets through the calls waiting that they cover', async () => {
    const { factory, operator, tui } = await carded();
    factory.executor.askPermission('R1', bash('toolu_2', 'npm publish --dry-run'));
    await settled(operator);

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'always' } })).toEqual({ ok: true });

    await tui.until((state) => state.runs.R1?.permission === null);
    await settled(operator);
    expect(readFileSync(factory.paths.permissionsPath, 'utf8')).toBe('allow:\n  - Bash(npm publish *)\n');
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true }, toolu_2: { allow: true } });
    expect(tui.state().runs.R1?.permission).toBeNull();
  });
});
