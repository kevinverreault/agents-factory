// Helpers shared by the Agent SDK contract tests.
import { randomUUID } from 'node:crypto';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { FACTORY_ALLOW_LIST } from '../permissions/permissions.ts';
import { isMetering, type Report, type RunEvent } from '../lifecycle/lifecycle.ts';
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
export function afkRun(cwd: string, firstMessage: string, maxTurns: number, allowRules: readonly string[] = FACTORY_ALLOW_LIST, reports: readonly Report[] = []): RunStart {
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
    token: null,
    container: null,
    plugin: null,
    // Its history starts nowhere: there is nothing from before the run to keep.
    guards: { start: '0'.repeat(40), env: {} },
    allowRules,
    reports,
    child: false,
    spawns: false,
    assumes: false,
  };
}

// A small TypeScript project's files, by name: `four` calls `double`, which
// is defined above it.
export function typeScriptProject(): Record<string, string> {
  return {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', target: 'es2024' } }),
    'math.ts': 'export function double(n: number): number {\n  return n * 2;\n}\n\nexport const four = double(2);\n',
  };
}

// What a run over `typeScriptProject()` is asked to prove code intelligence
// with: a symbol lookup, then an edit that breaks a type. Diagnostics reach
// the run a moment after the edit, with whatever it does next: here a pause.
export const CODE_INTELLIGENCE_TASK =
  'First use the LSP tool to find where `double` is defined in math.ts. ' +
  "Then use the Edit tool to change `double(2)` to `double('2')` in math.ts. " +
  'Then run `sleep 5` with the Bash tool, and no other command. ' +
  'Then reply with only the TypeScript error code (like TS1234) you were shown for math.ts after the edit, or NONE.';

// The error that edit introduces: argument of type 'string' is not
// assignable to parameter of type 'number'.
export const CODE_INTELLIGENCE_ERROR = 'TS2345';

// The types of the run events reported, in order, without usage metering's,
// which come with every API message and result, or usage snapshots, which
// come whenever the API sends the account's usage window.
export function typesOf(reported: RunEvent[]): RunEvent['type'][] {
  return reported.flatMap((event) => (isMetering(event) || event.type === 'usageSnapshotSeen' ? [] : [event.type]));
}
