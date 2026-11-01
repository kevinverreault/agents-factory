// Seam 1: the handoff, HITL → AFK. The agent may propose one; only the
// operator hands off, on the handoff sheet. The HITL run writes the brief the
// operator edits there, and confirming commits the task's uncommitted work,
// ends the run handed off and queues an AFK run starting from the brief. The
// walkthroughs of the hitl-handoff prototype, over the protocol.
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { relayHook } from '../hooks/relay.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import type { HandoffChoices } from '../lifecycle/lifecycle.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const prompt = 'Retry failed webhook deliveries.';

// A factory with T1 launched from `preset` (main-flow by default), in
// conversation at its first stage on R1, the agent mid-turn on its opening.
async function grilling(preset?: string): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt, ...(preset && { preset }) });
  if (!launched.ok) throw new Error(launched.reason);
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  return { factory, operator, tui };
}

describe('proposing a handoff', () => {
  test('propose_handoff shows a proposal on the run and changes nothing else', async () => {
    const { factory, tui } = await grilling();

    factory.executor.report('R1', { type: 'handoffProposed', reason: 'The retry policy is settled; the rest is implementation.' });

    const proposed = await tui.until((state) => state.runs.R1?.proposal !== null);
    expect(proposed.runs.R1).toMatchObject({
      status: 'active',
      proposal: { kind: 'handoff', reason: 'The retry policy is settled; the rest is implementation.' },
    });
    expect(proposed.tasks.T1).toMatchObject({ mode: 'HITL', stage: 'grill', liveRunId: 'R1', handoff: null });
    expect(factory.executor.started).toHaveLength(1);
    expect(factory.executor.stopped).toEqual([]);
    expect(factory.executor.interrupted).toEqual([]);
  });
});

// What the factory asks the HITL run for once the sheet opens.
const briefRequest = (factory: TestFactory) => factory.executor.sent.filter(({ text }) => text.includes('handoff brief'));

const brief = {
  goal: 'Failed webhook deliveries are retried instead of dropped.',
  decided: ['Retry 5xx and timeouts only; never 4xx.', 'Exhausted deliveries go to a dead-letter table.'],
  doneWhen: ['A 503 is retried 5 times with backoff.'],
  outOfScope: ['A replay UI for the dead-letter table.'],
  links: ['acme/widgets#31'],
};

describe('opening the handoff sheet', () => {
  test('mid-turn, it interrupts the agent, drops the open card and queued messages, and asks for the brief once the turn ends', async () => {
    const { factory, operator, tui } = await grilling();
    const question = {
      id: 'toolu_1',
      questions: [{ question: 'Retry 4xx too?', header: 'Retries', options: [{ label: 'No', description: '' }], multiSelect: false }],
    };
    factory.executor.report('R1', { type: 'questionAsked', question });
    await tui.until((state) => state.runs.R1?.question !== null);
    await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Also: cap the total retry time at 24h.' });

    expect(await operator.send({ type: 'openHandoff', taskId: 'T1' })).toEqual({ ok: true });

    const opened = await tui.until((state) => state.tasks.T1?.handoff !== null);
    expect(opened.tasks.T1?.handoff).toMatchObject({ brief: null, stage: 'implement' });
    expect(opened.runs.R1).toMatchObject({ status: 'active', turn: 'agent', question: null, queued: [] });
    expect(factory.executor.interrupted).toEqual(['R1']);
    // Asked only once the interrupted turn has ended, never on top of it.
    expect(briefRequest(factory)).toEqual([]);

    factory.executor.report('R1', { type: 'turnEnded' });
    await vi.waitFor(() => expect(briefRequest(factory)).toMatchObject([{ runId: 'R1' }]));
    expect(factory.executor.sent.map(({ text }) => text)).not.toContain('Also: cap the total retry time at 24h.');
    expect(tui.state().runs.R1).toMatchObject({ turn: 'agent' });

    factory.executor.report('R1', { type: 'briefWritten', brief });
    factory.executor.report('R1', { type: 'turnEnded' });

    const written = await tui.until((state) => state.tasks.T1?.handoff?.brief !== null && state.runs.R1?.turn === 'operator');
    expect(written.tasks.T1?.handoff?.brief).toEqual(brief);
    expect(written.tasks.T1).toMatchObject({ mode: 'HITL', liveRunId: 'R1' });
  });

  test('on the operator’s turn, the brief is asked for at once, with nothing to interrupt', async () => {
    const { factory, operator, tui } = await grilling();
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.turn === 'operator');

    await operator.send({ type: 'openHandoff', taskId: 'T1' });

    await tui.until((state) => state.runs.R1?.turn === 'agent');
    expect(briefRequest(factory)).toMatchObject([{ runId: 'R1' }]);
    expect(factory.executor.interrupted).toEqual([]);
  });
});

describe('the sheet’s fields', () => {
  test('pre-filled from the next AFK stage, the sheet pre-selects fresh from brief past 60% of the context window, resume otherwise', async () => {
    const { factory, operator, tui } = await grilling();
    factory.executor.report('R1', { type: 'turnEnded', context: { used: 118_000, window: 200_000 } });
    await operator.send({ type: 'openHandoff', taskId: 'T1' });

    const under = await tui.until((state) => state.tasks.T1?.handoff !== null);
    expect(under.tasks.T1?.handoff).toMatchObject({
      stage: 'implement',
      continueAs: 'resume',
      autonomy: 'L1',
      tier: 'sonnet',
      maxTurns: 300,
      contextShare: 0.59,
    });
    await operator.send({ type: 'closeHandoff', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.handoff === null);

    factory.executor.report('R1', { type: 'turnEnded', context: { used: 138_000, window: 200_000 } });
    await operator.send({ type: 'openHandoff', taskId: 'T1' });

    const over = await tui.until((state) => state.tasks.T1?.handoff !== null);
    expect(over.tasks.T1?.handoff).toMatchObject({ continueAs: 'fresh', contextShare: 0.69 });
  });
});

describe('handing off a parked conversation', () => {
  test('with no live run, the factory first starts a run resuming the session, just to write the brief', async () => {
    const { factory, operator, tui } = await grilling();
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.turn === 'operator');
    factory.clock.advance(30 * 60_000);
    await tui.until((state) => state.runs.R1?.outcome === 'parked');

    expect(await operator.send({ type: 'openHandoff', taskId: 'T1' })).toEqual({ ok: true });

    const resumed = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(resumed.runs.R2).toMatchObject({ mode: 'HITL', status: 'active', turn: 'agent', stage: 'grill' });
    expect(resumed.tasks.T1?.handoff).toMatchObject({ brief: null });
    const [grill, writer] = factory.executor.started;
    expect(writer).toMatchObject({ runId: 'R2', mode: 'HITL', sessionId: grill!.sessionId, resumesSession: true });
    expect(writer!.firstMessage).toContain('handoff brief');
  });

  test('a task that has had no conversation yet has nothing to hand off', async () => {
    const { operator, tui } = await grilling();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Plan the billing page', mode: 'HITL' });
    await tui.until((state) => state.tasks.T2 !== undefined);

    expect(await operator.send({ type: 'openHandoff', taskId: 'T2' })).toEqual({
      ok: false,
      reason: 'Only a HITL task in conversation or ready for you can be handed off (T2 is Draft).',
    });
  });
});

describe('backing out', () => {
  test('esc closes the sheet and the conversation carries on, on the same run', async () => {
    const { factory, operator, tui } = await grilling();
    await operator.send({ type: 'openHandoff', taskId: 'T1' });
    expect(await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'One more thing.' })).toEqual({
      ok: false,
      reason: 'The handoff sheet is open on T1: back out of it (esc) to keep talking.',
    });
    factory.executor.report('R1', { type: 'turnEnded' });
    factory.executor.report('R1', { type: 'briefWritten', brief });
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.tasks.T1?.handoff?.brief !== null && state.runs.R1?.turn === 'operator');

    expect(await operator.send({ type: 'closeHandoff', taskId: 'T1' })).toEqual({ ok: true });

    const closed = await tui.until((state) => state.tasks.T1?.handoff === null);
    expect(closed.tasks.T1).toMatchObject({ mode: 'HITL', label: 'Ready for you', liveRunId: 'R1' });
    expect(closed.runs.R1).toMatchObject({ status: 'active', outcome: null });
    expect(await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Retries must be idempotent.' })).toEqual({ ok: true });
    expect(factory.executor.sent.at(-1)).toEqual({ runId: 'R1', text: 'Retries must be idempotent.' });
    expect(factory.executor.stopped).toEqual([]);

    // Handing off again asks for a new brief, which picks up what was said since.
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.turn === 'operator');
    await operator.send({ type: 'openHandoff', taskId: 'T1' });
    expect((await tui.until((state) => state.tasks.T1?.handoff !== null)).tasks.T1?.handoff?.brief).toBeNull();
    await vi.waitFor(() => expect(briefRequest(factory)).toHaveLength(2));
    const again = { ...brief, decided: [...brief.decided, 'Retries are idempotent, keyed by delivery id.'] };
    factory.executor.report('R1', { type: 'briefWritten', brief: again });
    expect((await tui.until((state) => state.tasks.T1?.handoff?.brief != null)).tasks.T1?.handoff?.brief).toEqual(again);
  });
});

// The agent writes `path` in T1's worktree during its latest run, uncommitted,
// and artifact capture links it to T1.
async function agentWrites(factory: TestFactory, tui: Watched, path: string): Promise<void> {
  const { sessionId, cwd } = factory.executor.started[0]!;
  factory.git.editFile(cwd!, path);
  const before = Object.keys(tui.state().artifacts).length;
  const event = { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(cwd!, path) } };
  await relayHook(JSON.stringify({ ...event, tool_response: '' }), factory.paths);
  await tui.until((state) => Object.keys(state.artifacts).length > before);
}

// T1 grilled, with the sheet open on the brief R1 wrote, on the operator's turn.
async function briefed(preset?: string) {
  const grilled = await grilling(preset);
  const { factory, operator, tui } = grilled;
  factory.executor.report('R1', { type: 'turnEnded' });
  await operator.send({ type: 'openHandoff', taskId: 'T1' });
  factory.executor.report('R1', { type: 'briefWritten', brief });
  factory.executor.report('R1', { type: 'turnEnded' });
  await tui.until((state) => state.tasks.T1?.handoff?.brief !== null && state.runs.R1?.turn === 'operator');
  return grilled;
}

// The sheet's own fields, as the operator confirms them unchanged.
const confirm = (state: FactoryState, changes: Partial<HandoffChoices> = {}) => {
  const { brief, continueAs, autonomy, tier, maxTurns } = state.tasks.T1!.handoff!;
  return { type: 'handoff', taskId: 'T1', brief: brief!, continueAs, autonomy, tier, maxTurns, ...changes } as const;
};

describe('confirming the handoff', () => {
  test('commits the uncommitted work, ends the HITL run handed off and starts an AFK run on the edited brief', async () => {
    const { factory, operator, tui } = await grilling();
    await agentWrites(factory, tui, 'GLOSSARY.md');
    await agentWrites(factory, tui, 'docs/adr/0002-dead-letter-table.md');
    factory.executor.report('R1', { type: 'turnEnded' });
    await operator.send({ type: 'openHandoff', taskId: 'T1' });
    factory.executor.report('R1', { type: 'briefWritten', brief });
    const sheet = await tui.until((state) => state.tasks.T1?.handoff?.brief !== null);
    expect(sheet.tasks.T1?.handoff?.readiness).toEqual({ blockers: [], toCommit: ['GLOSSARY.md', 'docs/adr/0002-dead-letter-table.md'] });
    const edited = { ...brief, outOfScope: [...brief.outOfScope, 'The webhook signing code.'] };

    expect(await operator.send(confirm(sheet, { brief: edited }))).toEqual({ ok: true });

    const handedOff = await tui.until((state) => state.tasks.T1?.mode === 'AFK' && state.tasks.T1.liveRunId === 'R2');
    const { cwd, sessionId } = factory.executor.started[0]!;
    expect(factory.git.commits).toEqual([
      { worktreePath: cwd, paths: ['GLOSSARY.md', 'docs/adr/0002-dead-letter-table.md'], message: `Handoff of T1: ${handedOff.tasks.T1!.title}` },
    ]);
    expect(Object.values(handedOff.artifacts).map((artifact) => artifact.kind === 'file' && artifact.committed)).toEqual([true, true]);
    expect(handedOff.runs.R1).toMatchObject({ mode: 'HITL', status: 'ended', outcome: 'handed off' });
    expect(handedOff.tasks.T1).toMatchObject({ mode: 'AFK', autonomy: 'L1', stage: 'implement', label: 'Running', handoff: null });
    expect(factory.executor.stopped).toEqual(['R1']);
    const afk = factory.executor.started[1]!;
    expect(afk).toMatchObject({ runId: 'R2', mode: 'AFK', autonomy: 'L1', sessionId, resumesSession: true, model: 'claude-sonnet-5-5', maxTurns: 300 });
    // The brief stands in for the tickets an early handoff never made.
    expect(afk.firstMessage).toBe(`/factory:implement\n\n${handedOff.tasks.T1!.goal}`);
    expect(handedOff.tasks.T1!.goal).toBe(
      [
        '# Handoff brief',
        '',
        'Failed webhook deliveries are retried instead of dropped.',
        '',
        '## Decided',
        '',
        '- Retry 5xx and timeouts only; never 4xx.',
        '- Exhausted deliveries go to a dead-letter table.',
        '',
        '## Done when',
        '',
        '- A 503 is retried 5 times with backoff.',
        '',
        '## Out of scope',
        '',
        '- A replay UI for the dead-letter table.',
        '- The webhook signing code.',
        '',
        '## Links',
        '',
        '- acme/widgets#31',
      ].join('\n'),
    );
  });

  test('the sheet keeps up with what the agent changes in the worktree while it writes the brief', async () => {
    const { factory, operator, tui } = await grilling();
    const { cwd } = factory.executor.started[0]!;
    await operator.send({ type: 'openHandoff', taskId: 'T1' });
    expect((await tui.until((state) => state.tasks.T1?.handoff !== null)).tasks.T1?.handoff?.readiness).toEqual({ blockers: [], toCommit: [] });

    await agentWrites(factory, tui, 'GLOSSARY.md');
    await tui.until((state) => state.tasks.T1?.handoff?.readiness.toCommit.length === 1);
    factory.git.editFile(cwd!, 'src/scratch.ts');
    factory.executor.report('R1', { type: 'turnEnded' });

    const reread = await tui.until((state) => state.tasks.T1?.handoff?.readiness.blockers.length === 1);
    expect(reread.tasks.T1?.handoff?.readiness).toEqual({
      blockers: ['The worktree has changes that are no artifact of T1, which the handoff commit won’t take: src/scratch.ts. Commit or discard them first.'],
      toCommit: ['GLOSSARY.md'],
    });
  });

  test('fresh from brief starts the AFK run on a new session, at the tier and max turns the operator chose', async () => {
    const { factory, operator, tui } = await briefed();

    expect(await operator.send(confirm(tui.state(), { continueAs: 'fresh', tier: 'opus', maxTurns: 50 }))).toEqual({ ok: true });

    const handedOff = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    const [grill, afk] = factory.executor.started;
    expect(afk).toMatchObject({ resumesSession: false, model: 'claude-opus-5-5', maxTurns: 50 });
    expect(afk!.sessionId).not.toBe(grill!.sessionId);
    expect(handedOff.tasks.T1).toMatchObject({ sessionId: afk!.sessionId, tier: 'opus' });
  });

  test('confirm is refused until the agent has written the brief: the operator confirms what they have read', async () => {
    const { operator, tui } = await grilling();
    await operator.send({ type: 'openHandoff', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.handoff !== null);
    const { continueAs, autonomy, tier, maxTurns } = tui.state().tasks.T1!.handoff!;

    expect(await operator.send({ type: 'handoff', taskId: 'T1', brief, continueAs, autonomy, tier, maxTurns })).toEqual({
      ok: false,
      reason: 'The agent hasn’t written the brief yet: you confirm the brief you have read.',
    });
    expect(await operator.send({ type: 'handoff', taskId: 'T2', brief, continueAs, autonomy, tier, maxTurns })).toEqual({
      ok: false,
      reason: 'There is no task T2.',
    });
  });

  test('confirm is blocked while the task branch isn’t checked out, the tree has other changes or a remote has a pushurl', async () => {
    const { factory, operator, tui } = await briefed();
    const { cwd } = factory.executor.started[0]!;
    await agentWrites(factory, tui, 'GLOSSARY.md');
    factory.git.editFile(cwd!, 'src/scratch.ts');
    factory.git.checkout(cwd!, 'spike');
    factory.git.setPushUrl(cwd!, 'origin', 'https://github.com/someone/else.git');
    const branch = tui.state().tasks.T1!.branch;

    const blocked = await operator.send(confirm(tui.state()));

    const blockers = [
      `${branch} isn’t checked out in T1’s worktree: spike is.`,
      'The worktree has changes that are no artifact of T1, which the handoff commit won’t take: src/scratch.ts. Commit or discard them first.',
      'A remote has a pushurl, which the AFK run’s push guard can’t cover: remote.origin.pushurl. Remove it first.',
    ];
    expect(blocked).toEqual({ ok: false, reason: `The handoff is blocked. ${blockers.join(' ')}` });
    const state = await tui.until((state) => state.tasks.T1?.handoff?.readiness.blockers.length !== 0);
    expect(state.tasks.T1?.handoff?.readiness).toEqual({ blockers, toCommit: ['GLOSSARY.md'] });
    expect(state.tasks.T1).toMatchObject({ mode: 'HITL', liveRunId: 'R1' });
    expect(factory.git.commits).toEqual([]);

    factory.git.checkout(cwd!, branch!);
    factory.git.setPushUrl(cwd!, 'origin', null);
    factory.git.discard(cwd!, 'src/scratch.ts');
    expect(await operator.send(confirm(tui.state()))).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.mode === 'AFK');
  });

  test('a brief needs a goal, and the handoff an autonomy level the factory can run', async () => {
    const { operator, tui } = await briefed();

    expect(await operator.send(confirm(tui.state(), { brief: { ...brief, goal: '  ' } }))).toEqual({ ok: false, reason: 'The brief needs a goal.' });
    expect(await operator.send(confirm(tui.state(), { autonomy: 'L2' }))).toEqual({
      ok: false,
      reason: 'L2 runs in a sandbox, which the factory doesn’t have yet: hand off at L1.',
    });
    expect(await operator.send(confirm(tui.state(), { maxTurns: 0 }))).toEqual({ ok: false, reason: 'Max turns must be a whole number of at least 1.' });
  });

  test('a preset with no AFK stage ahead hands off to one AFK run on the brief, then In review', async () => {
    const { factory, operator, tui } = await briefed('setup');
    expect(tui.state().tasks.T1?.handoff).toMatchObject({ stage: null });

    await operator.send(confirm(tui.state()));

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(factory.executor.started[1]!.firstMessage).toBe(tui.state().tasks.T1!.goal);
    factory.executor.report('R2', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'In review');
  });
});
