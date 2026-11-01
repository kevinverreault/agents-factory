// Helpers shared by the Agent SDK contract tests.
import { randomUUID } from 'node:crypto';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { FACTORY_ALLOW_LIST } from '../permissions/permissions.ts';
import type { RunStart } from './executor.ts';

export { streamedInput, type StreamedInput } from './streamed-input.ts';

// An AFK run on the `subscription-host` profile (ADRs 0001, 0005), on haiku to
// keep the usage small: project settings only, no auto memory, no API key.
export function afkRunOptions(cwd: string) {
  const { ANTHROPIC_API_KEY, ...env } = process.env;
  return {
    cwd,
    model: 'haiku',
    permissionMode: 'default',
    settingSources: ['project'],
    env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
  } satisfies Options;
}

// An L1 AFK run on haiku in `cwd`, as the executor starts it, with the
// factory's allow list unless the test gives other rules.
export function afkRun(cwd: string, firstMessage: string, maxTurns: number, allowRules: readonly string[] = FACTORY_ALLOW_LIST): RunStart {
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
    // Its history starts nowhere: there is nothing from before the run to keep.
    guards: { start: '0'.repeat(40), env: {} },
    allowRules,
  };
}
