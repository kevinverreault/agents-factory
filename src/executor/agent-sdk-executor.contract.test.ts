// Seam 3: the Agent SDK adapter behind the executor port, on the operator's
// Windows machine. HITL conversations on haiku: they spend a little usage.
// The resume check runs the operator's own `claude` from PATH.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import type { RunEvent } from '../lifecycle/lifecycle.ts';
import { isAlive, waitFor } from '../os/test-support.ts';
import { agentSdkExecutor } from './agent-sdk.ts';
import type { ConversationEvent, RunStart } from './executor.ts';

test('a HITL run streams text and tool use, takes the operator’s messages, records its CLI, and replays from the session file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'factory-hitl-'));
  writeFileSync(join(cwd, 'secret.txt'), 'the word is PERIWINKLE-42\n');
  const executor = agentSdkExecutor();
  const reported: RunEvent[] = [];
  const live: ConversationEvent[] = [];
  const run: RunStart = {
    runId: 'R1',
    taskId: 'T1',
    mode: 'HITL',
    autonomy: null,
    sessionId: randomUUID(),
    resumesSession: false,
    cwd,
    firstMessage: 'Use the Read tool to read secret.txt, then reply with only the word it contains.',
    model: 'claude-haiku-5-5',
    maxTurns: null,
    credential: 'subscription-host',
    plugin: null,
  };
  const startedAt = Date.now();
  const agentSaid = (text: string) => live.some((event) => event.type === 'message' && event.from === 'agent' && event.text.includes(text));
  const turnsEnded = () => reported.filter((event) => event.type === 'turnEnded').length;

  executor.start(run, { report: (event) => reported.push(event), converse: (event) => live.push(event) });
  await waitFor(() => turnsEnded() === 1, 120_000);
  expect(agentSaid('PERIWINKLE-42')).toBe(true);
  executor.send('R1', 'Now reply with only the word PONG.');
  await waitFor(() => turnsEnded() === 2, 120_000);
  expect(agentSaid('PONG')).toBe(true);

  const started = reported.find((event) => event.type === 'runStarted');
  expect(started).toMatchObject({ runId: 'R1', model: expect.stringMatching(/^claude-haiku-5-5/) });
  const { pid, createdAt } = started as Extract<RunEvent, { type: 'runStarted' }>;
  expect(isAlive(pid)).toBe(true);
  expect(createdAt).toBeGreaterThanOrEqual(startedAt - 2_000);
  expect(createdAt).toBeLessThanOrEqual(Date.now());
  expect(live.map(({ id, ...event }) => event)).toEqual([
    { type: 'message', from: 'operator', text: run.firstMessage },
    { type: 'toolUse', tool: 'Read', summary: expect.stringContaining('secret.txt') },
    expect.objectContaining({ type: 'message', from: 'agent', text: expect.stringContaining('PERIWINKLE-42') }),
    { type: 'message', from: 'operator', text: 'Now reply with only the word PONG.' },
    expect.objectContaining({ type: 'message', from: 'agent', text: expect.stringContaining('PONG') }),
  ]);
  // A HITL run lives on between turns: only the operator ends it.
  expect(reported.map((event) => event.type)).toEqual(['runStarted', 'turnEnded', 'turnEnded']);

  // Live and replayed, an event has the same id, so a replay can skip what it
  // already sent. The CLI writes the session file a moment after it streams.
  let history: ConversationEvent[] = [];
  for (const deadline = Date.now() + 10_000; history.length < live.length && Date.now() < deadline; ) {
    history = await executor.history({ sessionId: run.sessionId, cwd });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(history).toEqual(live);

  executor.stop('R1');
  await waitFor(() => !isAlive(pid), 15_000);
  expect(reported.map((event) => event.type)).toEqual(['runStarted', 'turnEnded', 'turnEnded']);
});

test('the agent proposes advancing through the factory MCP server’s propose_advance, with no permission prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'factory-hitl-'));
  const executor = agentSdkExecutor();
  const reported: RunEvent[] = [];
  const live: ConversationEvent[] = [];
  const run: RunStart = {
    runId: 'R1',
    taskId: 'T1',
    mode: 'HITL',
    autonomy: null,
    sessionId: randomUUID(),
    resumesSession: false,
    cwd,
    firstMessage: 'Call the propose_advance tool with the reason "the colour is settled", then reply with only the word PROPOSED.',
    model: 'claude-haiku-5-5',
    maxTurns: null,
    credential: 'subscription-host',
    plugin: null,
  };

  executor.start(run, { report: (event) => reported.push(event), converse: (event) => live.push(event) });
  await waitFor(() => reported.some((event) => event.type === 'turnEnded'), 120_000);

  expect(reported.find((event) => event.type === 'advanceProposed')).toEqual({
    type: 'advanceProposed',
    runId: 'R1',
    reason: expect.stringContaining('colour is settled'),
  });
  expect(live).toContainEqual(expect.objectContaining({ type: 'toolUse', tool: 'mcp__factory__propose_advance' }));
  expect(live).toContainEqual(expect.objectContaining({ type: 'message', from: 'agent', text: expect.stringContaining('PROPOSED') }));
  executor.stop('R1');
});

test('AskUserQuestion holds the turn until answered, an interrupt ends only the turn, and the session resumes with `claude --resume` in a terminal', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'factory-hitl-'));
  const executor = agentSdkExecutor();
  const reported: RunEvent[] = [];
  const live: ConversationEvent[] = [];
  const run: RunStart = {
    runId: 'R1',
    taskId: 'T1',
    mode: 'HITL',
    autonomy: null,
    sessionId: randomUUID(),
    resumesSession: false,
    cwd,
    firstMessage:
      'Use the AskUserQuestion tool to ask me which colour I prefer, with exactly two options: Red and Blue. ' +
      'After I answer, reply with only the colour I chose, in capitals.',
    model: 'claude-haiku-5-5',
    maxTurns: null,
    credential: 'subscription-host',
    plugin: null,
  };
  const agentSaid = (text: string) => live.some((event) => event.type === 'message' && event.from === 'agent' && event.text.includes(text));
  const turnsEnded = () => reported.filter((event) => event.type === 'turnEnded').length;
  const asked = () => reported.find((event) => event.type === 'questionAsked');

  executor.start(run, { report: (event) => reported.push(event), converse: (event) => live.push(event) });
  await waitFor(() => asked() !== undefined, 120_000);
  const { question } = asked() as Extract<RunEvent, { type: 'questionAsked' }>;
  expect(question.questions).toEqual([
    expect.objectContaining({ options: [expect.objectContaining({ label: 'Red' }), expect.objectContaining({ label: 'Blue' })] }),
  ]);
  // The card holds the turn open.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(turnsEnded()).toBe(0);
  executor.answer('R1', question.id, { [question.questions[0]!.question]: 'Blue' });
  await waitFor(() => turnsEnded() === 1, 120_000);
  expect(agentSaid('BLUE')).toBe(true);

  executor.send('R1', 'Use the Bash tool to run `sleep 120`. After it finishes, say DONE-SLEEPING.');
  await waitFor(() => live.some((event) => event.type === 'toolUse' && event.tool === 'Bash'), 120_000);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const interruptedAt = Date.now();
  executor.interrupt('R1');
  await waitFor(() => turnsEnded() === 2, 15_000);
  expect(Date.now() - interruptedAt).toBeLessThan(15_000);
  expect(agentSaid('DONE-SLEEPING')).toBe(false);
  // The run lives on after an interrupt: only the operator ends it.
  expect(reported.map((event) => event.type)).toEqual(['runStarted', 'questionAsked', 'turnEnded', 'turnEnded']);
  const { pid } = reported[0] as Extract<RunEvent, { type: 'runStarted' }>;
  executor.stop('R1');
  await waitFor(() => !isAlive(pid), 15_000);

  // The operator's own `claude`, in the task's worktree, as the conversation view shows.
  const { ANTHROPIC_API_KEY, ...env } = process.env;
  const { stdout } = await promisify(execFile)(
    'claude',
    ['--resume', run.sessionId, '--model', 'claude-haiku-5-5', '-p', 'Which colour did I choose? Reply with only the colour, in capitals.'],
    { cwd, env, timeout: 120_000 },
  );
  expect(stdout).toContain('BLUE');
});

// An L1 AFK run on haiku, in a fresh directory.
function afkRun(cwd: string, firstMessage: string, maxTurns: number): RunStart {
  return {
    runId: 'R1',
    taskId: 'T1',
    mode: 'AFK',
    autonomy: 'L1',
    sessionId: randomUUID(),
    resumesSession: false,
    cwd,
    firstMessage,
    model: 'claude-haiku-5-5',
    maxTurns,
    credential: 'subscription-host',
    plugin: null,
  };
}

test('an L1 AFK run edits in its worktree without asking, takes no chat, and completes on its own when its turn ends', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'factory-afk-'));
  const executor = agentSdkExecutor();
  const reported: RunEvent[] = [];
  const live: ConversationEvent[] = [];
  const run = afkRun(cwd, 'Use the Write tool to create done.txt containing only the word FINISHED. Then reply with only OK.', 10);

  executor.start(run, { report: (event) => reported.push(event), converse: (event) => live.push(event) });
  await waitFor(() => reported.some((event) => event.type === 'runCompleted' || event.type === 'runFailed'), 120_000);

  expect(reported.map((event) => event.type)).toEqual(['runStarted', 'runCompleted']);
  expect(readFileSync(join(cwd, 'done.txt'), 'utf8').trim()).toBe('FINISHED');
  expect(live).toContainEqual(expect.objectContaining({ type: 'toolUse', tool: 'Write' }));
  const { pid } = reported[0] as Extract<RunEvent, { type: 'runStarted' }>;
  await waitFor(() => !isAlive(pid), 15_000);
});

test('an AFK run that hits its max turns ends failed, saying so', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'factory-afk-'));
  for (const name of ['a', 'b', 'c']) writeFileSync(join(cwd, `${name}.txt`), `${name}\n`);
  const executor = agentSdkExecutor();
  const reported: RunEvent[] = [];
  const run = afkRun(cwd, 'Use the Read tool on a.txt, then on b.txt, then on c.txt, one call at a time. Then reply with their contents.', 1);

  executor.start(run, { report: (event) => reported.push(event), converse: () => {} });
  await waitFor(() => reported.some((event) => event.type === 'runCompleted' || event.type === 'runFailed'), 120_000);
  // Nothing more is reported once the run has ended.
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  expect(reported.map((event) => event.type)).toEqual(['runStarted', 'runFailed']);
  expect(reported[1]).toMatchObject({ reason: 'The run hit its max turns (1) before it finished.' });
});
