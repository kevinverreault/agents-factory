// The namer the daemon names tasks with: one Haiku turn through the Agent
// SDK, with no tools, no settings, no MCP servers and no saved session, on
// the operator's subscription as a host run is (ADR 0001).
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { NAMING_INSTRUCTIONS, type Namer } from './task-naming.ts';

export function claudeNamer({ model = 'haiku' }: { model?: string } = {}): Namer {
  return {
    async name(request, signal) {
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      const { ANTHROPIC_API_KEY, ...env } = process.env;
      const replies = query({
        prompt: request,
        options: {
          model,
          systemPrompt: NAMING_INSTRUCTIONS,
          tools: [],
          maxTurns: 1,
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          cwd: tmpdir(),
          env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
          abortController,
        },
      });
      let answered = false;
      try {
        for await (const message of replies) {
          if (message.type !== 'result') continue;
          if (message.subtype !== 'success') throw new Error(`The namer ended with ${message.subtype}.`);
          answered = true;
          return message.result;
        }
        throw new Error('The namer ended without a result.');
      } finally {
        signal.removeEventListener('abort', abort);
        // A turn that failed takes its CLI with it; one that answered has ended.
        if (!answered) abort();
      }
    },
  };
}
