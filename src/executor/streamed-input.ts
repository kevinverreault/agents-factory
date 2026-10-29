// Streaming input: a run reads the operator's messages from a queue the
// factory feeds, so one run carries a whole conversation.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type StreamedInput = {
  messages: AsyncIterable<SDKUserMessage>;
  // `uuid` names the message in the session file.
  send(text: string, uuid?: SDKUserMessage['uuid']): void;
  close(): void;
};

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
    send(text, uuid) {
      queued.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        ...(uuid && { uuid }),
      });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}
