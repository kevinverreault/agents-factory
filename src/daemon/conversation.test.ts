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
// The first message: main-flow's first stage, its skill on the prompt.
const opening = `/factory:grill-with-docs ${prompt}`;

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
    // Shown, so the operator can `claude --resume` it in their own terminal.
    expect(state.tasks.T1?.sessionId).toBe(factory.executor.started[0]?.sessionId);
    expect(factory.executor.started).toEqual([
      {
        runId: 'R1',
        taskId: 'T1',
        mode: 'HITL',
        autonomy: null,
        sessionId: expect.stringMatching(UUID),
        resumesSession: false,
        cwd: worktree,
        firstMessage: opening,
        model: 'claude-opus-5-5',
        maxTurns: null,
        credential: 'subscription-host',
        plugin: factory.skillSets.pathOf('a1a1a1a1a1a1a1a1'),
        guards: null,
      },
    ]);
  });

  test('a launch is refused, with a reason and nothing left behind, without a registered repository, a prompt or a reachable origin', async () => {
    const { factory, operator, tui } = await attached();

    expect(await operator.send({ type: 'launchTask', repo: 'acme/gadgets', prompt })).toEqual({
      ok: false,
      reason: 'acme/gadgets is not registered.',
    });
    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: '  \n ' })).toEqual({
      ok: false,
      reason: 'Starting main-flow at grill needs a prompt.',
    });
    factory.git.cutOffOrigin(widgets, 'fatal: unable to access github.com: Could not resolve host');
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
    factory.executor.report('R1', { type: 'turnEnded' });
    expect(await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Okta, only on Safari.' })).toEqual({ ok: true });
    factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Then it is the third-party cookie.' });

    expect(await conversation.until(5)).toEqual([
      { type: 'message', from: 'operator', text: opening },
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
      reason: 'T2 is AFK, so it takes no chat. Take it over to talk to it.',
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
      { type: 'message', from: 'operator', text: opening },
      { type: 'message', from: 'agent', text: 'Which identity provider times out?' },
      { type: 'toolUse', tool: 'Bash', summary: 'git log --oneline -5' },
    ]);
    const { sessionId, cwd } = factory.executor.started[0]!;
    expect(factory.executor.historyReads.at(-1)).toEqual({ sessionId, cwd, archive: null });

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
      { type: 'message', from: 'operator', text: opening },
      { type: 'message', from: 'agent', text: 'Which identity provider times out?' },
      { type: 'message', from: 'agent', text: 'Okta?' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(conversation.events).toHaveLength(3);
  });
});

describe('conversation controls', () => {
  test('messages sent mid-turn wait, shown as queued, and reach the run together when the turn ends', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });

    // The agent's turn on the launch prompt is still going.
    expect(await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Also check Safari.' })).toEqual({ ok: true });
    expect(await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'And the mobile app.' })).toEqual({ ok: true });
    const queued = await tui.until((state) => state.runs.R1?.queued.length === 2);
    expect(queued.runs.R1).toMatchObject({ turn: 'agent', queued: ['Also check Safari.', 'And the mobile app.'] });
    expect(factory.executor.sent).toEqual([]);

    factory.executor.report('R1', { type: 'turnEnded' });

    const delivered = await tui.until((state) => state.runs.R1?.queued.length === 0);
    expect(delivered.runs.R1).toMatchObject({ turn: 'agent', queued: [] });
    expect(factory.executor.sent).toEqual([{ runId: 'R1', text: 'Also check Safari.\n\nAnd the mobile app.' }]);

    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.turn === 'operator');
    await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Thanks.' });
    expect(factory.executor.sent.at(-1)).toEqual({ runId: 'R1', text: 'Thanks.' });
    expect((await tui.until((state) => state.runs.R1?.turn === 'agent')).runs.R1?.queued).toEqual([]);
  });

  test('interrupting cuts the agent’s turn on the executor, and a message waiting on that turn then reaches the run', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
    await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Stop, it is Okta.' });

    expect(await operator.send({ type: 'interrupt', taskId: 'T1' })).toEqual({ ok: true });
    expect(factory.executor.interrupted).toEqual(['R1']);
    // The run lives on: an interrupt ends only the turn.
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.queued.length === 0);
    expect(tui.state().runs.R1).toMatchObject({ status: 'active', turn: 'agent' });
    expect(factory.executor.sent).toEqual([{ runId: 'R1', text: 'Stop, it is Okta.' }]);
  });

  test('an interrupt is refused, with a reason, when the agent isn’t mid-turn', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.turn === 'operator');

    expect(await operator.send({ type: 'interrupt', taskId: 'T1' })).toEqual({ ok: false, reason: 'T1’s agent isn’t mid-turn.' });
    await operator.send({ type: 'cancel', taskId: 'T1' });
    expect(await operator.send({ type: 'interrupt', taskId: 'T1' })).toEqual({ ok: false, reason: 'T1 has no live conversation.' });
    expect(factory.executor.interrupted).toEqual([]);
  });

  const question = {
    id: 'toolu_01',
    questions: [
      {
        question: 'Which identity provider times out?',
        header: 'IdP',
        options: [
          { label: 'Okta', description: 'The workforce SSO' },
          { label: 'Auth0', description: 'The customer login' },
        ],
        multiSelect: false,
      },
    ],
  };

  test('an AskUserQuestion call shows as a card on the run and raises no attention request, and the answer reaches the run', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });

    factory.executor.report('R1', { type: 'questionAsked', question });

    const asked = await tui.until((state) => state.runs.R1?.question !== null);
    expect(asked.runs.R1?.question).toEqual(question);
    expect(asked.tasks.T1?.state).toBe('running');
    expect(asked.attentionQueue.filter((item) => item.kind === 'attention')).toEqual([]);

    const answers = { 'Which identity provider times out?': 'Okta' };
    expect(await operator.send({ type: 'answerQuestion', taskId: 'T1', questionId: 'toolu_01', answers })).toEqual({ ok: true });
    expect(factory.executor.answered).toEqual([{ runId: 'R1', questionId: 'toolu_01', answers }]);
    expect((await tui.until((state) => state.runs.R1?.question === null)).runs.R1?.turn).toBe('agent');
    expect(await operator.send({ type: 'answerQuestion', taskId: 'T1', questionId: 'toolu_01', answers })).toEqual({
      ok: false,
      reason: 'That question is no longer open.',
    });
  });

  test('a card is answered whole, and the end of its turn drops it unanswered', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
    factory.executor.report('R1', { type: 'questionAsked', question });
    await tui.until((state) => state.runs.R1?.question !== null);

    expect(await operator.send({ type: 'answerQuestion', taskId: 'T1', questionId: 'toolu_01', answers: {} })).toEqual({
      ok: false,
      reason: 'Answer every question on the card.',
    });
    await operator.send({ type: 'interrupt', taskId: 'T1' });
    factory.executor.report('R1', { type: 'turnEnded' });

    expect((await tui.until((state) => state.runs.R1?.question === null)).runs.R1?.turn).toBe('operator');
    expect(factory.executor.answered).toEqual([]);
  });

  test('a HITL task waiting on the operator is Ready for you in Needs you while no TUI has its conversation open', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
    const here = listen(operator, 'R1');
    await here.until(1);
    factory.executor.report('R1', { type: 'turnEnded' });
    const yourTurn = await tui.until((state) => state.runs.R1?.turn === 'operator');
    expect(yourTurn.tasks.T1?.label).toBe('In conversation');
    expect(yourTurn.attentionQueue).toEqual([]);

    here.stop();
    const away = await tui.until((state) => state.tasks.T1?.label === 'Ready for you');
    expect(away.attentionQueue).toEqual([{ kind: 'ready', taskId: 'T1' }]);

    // Another TUI with the conversation open counts until it goes away.
    const elsewhere = await factory.attach();
    listen(elsewhere, 'R1');
    expect((await tui.until((state) => state.tasks.T1?.label === 'In conversation')).attentionQueue).toEqual([]);
    elsewhere.close();
    await tui.until((state) => state.tasks.T1?.label === 'Ready for you');

    // On the agent's turn nothing waits on the operator, until it asks.
    await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Okta, only on Safari.' });
    const busy = await tui.until((state) => state.runs.R1?.turn === 'agent');
    expect(busy.tasks.T1?.label).toBe('In conversation');
    expect(busy.attentionQueue).toEqual([]);
    factory.executor.report('R1', { type: 'questionAsked', question });
    expect((await tui.until((state) => state.tasks.T1?.label === 'Ready for you')).attentionQueue).toEqual([{ kind: 'ready', taskId: 'T1' }]);
  });
});

test('a TUI that subscribes before the session file catches up still gets what the run already streamed', async () => {
  const { factory, operator } = await attached();
  await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
  factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Which identity provider times out?' });
  factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Okta?' }, { inHistory: false });

  const conversation = listen(operator, 'R1');

  expect(await conversation.until(3)).toEqual([
    { type: 'message', from: 'operator', text: opening },
    { type: 'message', from: 'agent', text: 'Which identity provider times out?' },
    { type: 'message', from: 'agent', text: 'Okta?' },
  ]);
});

describe('the run record', () => {
  test('a run records its CLI PID, the process creation time and the exact model the CLI runs, across a daemon restart', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt });
    const routed = await tui.until((state) => state.runs.R1 !== undefined);
    expect(routed.runs.R1).toMatchObject({ model: 'claude-opus-5-5', cli: null });

    factory.executor.report('R1', { type: 'runStarted', pid: 4242, createdAt: 1_761_000_000_123, model: 'claude-opus-5-5-20261001' });

    const started = await tui.until((state) => state.runs.R1?.cli !== null);
    expect(started.runs.R1).toMatchObject({ model: 'claude-opus-5-5-20261001', cli: { pid: 4242, createdAt: 1_761_000_000_123 } });
    await factory.restart();
    const again = watch(await factory.attach());
    expect((await again.until(() => true)).runs.R1).toMatchObject({
      model: 'claude-opus-5-5-20261001',
      cli: { pid: 4242, createdAt: 1_761_000_000_123 },
    });
  });
});
