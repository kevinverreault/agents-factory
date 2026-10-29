// Helpers shared by the Agent SDK contract tests.
import type { Options } from '@anthropic-ai/claude-agent-sdk';

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
