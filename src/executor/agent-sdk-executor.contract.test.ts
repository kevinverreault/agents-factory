// Seam 3: the Agent SDK adapter behind the executor port, on the operator's
// Windows machine. One HITL conversation on haiku: it spends a little usage.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    credential: 'subscription-host',
    plugin: null,
  };
  const startedAt = Date.now();
  const agentSaid = (text: string) => live.some((event) => event.type === 'message' && event.from === 'agent' && event.text.includes(text));

  executor.start(run, { report: (event) => reported.push(event), converse: (event) => live.push(event) });
  await waitFor(() => agentSaid('PERIWINKLE-42'), 120_000);
  executor.send('R1', 'Now reply with only the word PONG.');
  await waitFor(() => agentSaid('PONG'), 120_000);

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
  expect(reported.map((event) => event.type)).toEqual(['runStarted']);

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
  expect(reported.map((event) => event.type)).toEqual(['runStarted']);
});
