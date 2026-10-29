// Helpers shared by the Agent SDK contract tests.
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type StreamedInput = {
  messages: AsyncIterable<SDKUserMessage>;
  send(text: string): void;
  close(): void;
};

// Streaming input: the run reads user messages from a queue the test feeds.
export function streamedInput(): StreamedInput {
  const queued: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    messages: (async function* () {
      while (true) {
        while (queued.length > 0) yield queued.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    })(),
    send(text) {
      queued.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

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
