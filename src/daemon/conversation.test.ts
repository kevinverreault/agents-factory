// Seam 1: launching a HITL task and conversing with it, through the client
// protocol, with the fake executor playing the agent.
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ConversationEvent } from '../executor/executor.ts';
import type { FactoryConnection } from '../protocol/client.ts';
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const prompt = 'Grill me about the login flow.\nIt keeps timing out after the SSO redirect.';

describe('launching a HITL task', () => {
  test('launching cuts the task branch from a freshly fetched origin/<base_branch> into one worktree, and opens the conversation there', async () => {
    const { factory, operator, tui } = await attached();
    const tip = factory.git.advanceOrigin(widgets, 'main');

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt })).toEqual({ ok: true, value: { taskId: 'T1' } });

    const worktree = join(factory.paths.worktreeRoot, 'acme-widgets', 'T1');
    const branch = 'factory/T1-grill-me-about-the-login-flow';
    expect(await factory.git.worktrees(widgets)).toEqual([{ path: worktree, branch, head: tip }]);
    const state = await tui.until((state) => state.tasks.T1?.label === 'In conversation');
    expect(state.tasks.T1).toMatchObject({ title: 'Grill me about the login flow.', mode: 'HITL', branch, worktree, liveRunId: 'R1' });
    expect(factory.executor.started).toEqual([
      {
        runId: 'R1',
        taskId: 'T1',
        mode: 'HITL',
        autonomy: null,
        sessionId: expect.stringMatching(UUID),
        resumesSession: false,
        cwd: worktree,
        firstMessage: prompt,
        model: 'claude-sonnet-5-5',
        credential: 'subscription-host',
      },
    ]);
  });

  test('a launch is refused, with a reason and nothing left behind, without a registered repository, a prompt or a reachable origin', async () => {
    const { factory, operator, tui } = await attached();
    factory.git.cutOffOrigin(widgets, 'fatal: unable to access github.com: Could not resolve host');

    expect(await operator.send({ type: 'launchTask', repo: 'acme/gadgets', prompt })).toEqual({
      ok: false,
      reason: 'acme/gadgets is not registered.',
    });
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: '  \n ' })).toEqual({
      ok: false,
      reason: 'A task needs a prompt.',
    });
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt })).toEqual({
      ok: false,
      reason: "Couldn't fetch main from the origin of acme/widgets: fatal: unable to access github.com: Could not resolve host",
    });

    await operator.send({ type: 'daemon.status' });
    expect(tui.state().tasks).toEqual({});
    expect(await factory.git.worktrees(widgets)).toEqual([]);
    expect(factory.executor.started).toEqual([]);
  });
});

// Everything the conversation subscription for `runId` delivers.
function listen(connection: FactoryConnection, runId: string) {
  const events: ConversationEvent[] = [];
  const stop = connection.converse(runId, (event) => events.push(event));
  return {
    events,
    stop,
    async until(count: number) {
      for (let waited = 0; events.length < count; waited += 10) {
        if (waited > 2_000) throw new Error(`Only ${events.length} of ${count} conversation events arrived.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return events.map(({ id, ...event }) => event);
    },
  };
}

describe('conversing', () => {
  test('the conversation streams the agent’s text and tool use live, and the operator’s messages reach the run', async () => {
    const { factory, operator } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
    const conversation = listen(operator, 'R1');

    factory.executor.converse('R1', { type: 'toolUse', tool: 'Read', summary: 'src/auth/sso.ts' });
    factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Which identity provider times out?' });
    expect(await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Okta, only on Safari.' })).toEqual({ ok: true });
    factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Then it is the third-party cookie.' });

    expect(await conversation.until(5)).toEqual([
      { type: 'message', from: 'operator', text: prompt },
      { type: 'toolUse', tool: 'Read', summary: 'src/auth/sso.ts' },
      { type: 'message', from: 'agent', text: 'Which identity provider times out?' },
      { type: 'message', from: 'operator', text: 'Okta, only on Safari.' },
      { type: 'message', from: 'agent', text: 'Then it is the third-party cookie.' },
    ]);
    expect(factory.executor.sent).toEqual([{ runId: 'R1', text: 'Okta, only on Safari.' }]);
  });

  test('a message is refused, with a reason, to a task with no live conversation or without text', async () => {
    const { factory, operator } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Implement the store', mode: 'AFK', submit: true });

    expect(await operator.send({ type: 'sendMessage', taskId: 'T1', text: ' ' })).toEqual({ ok: false, reason: 'A message needs text.' });
    expect(await operator.send({ type: 'sendMessage', taskId: 'T2', text: 'Hello?' })).toEqual({
      ok: false,
      reason: 'T2 has no live conversation.',
    });
    await operator.send({ type: 'cancel', taskId: 'T1' });
    expect(await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Hello?' })).toEqual({
      ok: false,
      reason: 'T1 has no live conversation.',
    });
    expect(factory.executor.sent).toEqual([]);
  });

  test('detaching and reattaching a TUI replays the conversation from the session file, then continues live', async () => {
    const { factory, operator } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
    const first = listen(operator, 'R1');
    factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Which identity provider times out?' });
    await first.until(2);
    operator.close();

    factory.executor.converse('R1', { type: 'toolUse', tool: 'Bash', summary: 'git log --oneline -5' });
    const reattached = await factory.attach();
    const second = listen(reattached, 'R1');
    expect(await second.until(3)).toEqual([
      { type: 'message', from: 'operator', text: prompt },
      { type: 'message', from: 'agent', text: 'Which identity provider times out?' },
      { type: 'toolUse', tool: 'Bash', summary: 'git log --oneline -5' },
    ]);
    const { sessionId, cwd } = factory.executor.started[0]!;
    expect(factory.executor.historyReads.at(-1)).toEqual({ sessionId, cwd });

    factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Found it.' });
    expect((await second.until(4)).at(-1)).toEqual({ type: 'message', from: 'agent', text: 'Found it.' });
  });

  test('an event that lands while the history is being read is shown once, after the history', async () => {
    const { factory, operator } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
    const release = factory.executor.holdHistory();
    const conversation = listen(operator, 'R1');
    await operator.send({ type: 'daemon.status' });

    factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Which identity provider times out?' });
    factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Okta?' }, { inHistory: false });
    release();

    expect(await conversation.until(3)).toEqual([
      { type: 'message', from: 'operator', text: prompt },
      { type: 'message', from: 'agent', text: 'Which identity provider times out?' },
      { type: 'message', from: 'agent', text: 'Okta?' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(conversation.events).toHaveLength(3);
  });
});

test('a TUI that subscribes before the session file catches up still gets what the run already streamed', async () => {
  const { factory, operator } = await attached();
  await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
  factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Which identity provider times out?' });
  factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Okta?' }, { inHistory: false });

  const conversation = listen(operator, 'R1');

  expect(await conversation.until(3)).toEqual([
    { type: 'message', from: 'operator', text: prompt },
    { type: 'message', from: 'agent', text: 'Which identity provider times out?' },
    { type: 'message', from: 'agent', text: 'Okta?' },
  ]);
});

describe('the run record', () => {
  test('a run records its CLI PID, the process creation time and the exact model the CLI runs, across a daemon restart', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
    const routed = await tui.until((state) => state.runs.R1 !== undefined);
    expect(routed.runs.R1).toMatchObject({ model: 'claude-sonnet-5-5', cli: null });

    factory.executor.report('R1', { type: 'runStarted', pid: 4242, createdAt: 1_761_000_000_123, model: 'claude-sonnet-5-5-20261001' });

    const started = await tui.until((state) => state.runs.R1?.cli !== null);
    expect(started.runs.R1).toMatchObject({ model: 'claude-sonnet-5-5-20261001', cli: { pid: 4242, createdAt: 1_761_000_000_123 } });
    await factory.restart();
    const again = watch(await factory.attach());
    expect((await again.until(() => true)).runs.R1).toMatchObject({
      model: 'claude-sonnet-5-5-20261001',
      cli: { pid: 4242, createdAt: 1_761_000_000_123 },
    });
  });
});
