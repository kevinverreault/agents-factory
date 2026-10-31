// The per-run factory MCP server: the factory's own tools, which a run's
// agent calls as `mcp__factory__<tool>`. Each reports a run event; the daemon
// decides what it means. A HITL run gets `propose_advance`; the delegation
// tools join with their own slices.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RunSink } from './executor.ts';

const SERVER = 'factory';

export type FactoryTools = {
  server: McpSdkServerConfigWithInstance;
  // Their full names, allowed without a permission prompt.
  allowed: string[];
};

export function hitlFactoryTools(runId: string, sink: RunSink): FactoryTools {
  const proposeAdvance = tool(
    'propose_advance',
    'Propose moving on to the next stage of the workflow, once this stage’s work is done. ' +
      'Only the operator advances: they see your proposal and confirm it when they are ready. Keep the conversation going meanwhile.',
    { reason: z.string().describe('Why this stage is done, in one sentence.') },
    async ({ reason }) => {
      sink.report({ type: 'advanceProposed', runId, reason });
      return { content: [{ type: 'text', text: 'The operator sees your proposal and will advance when they are ready.' }] };
    },
  );
  return {
    server: createSdkMcpServer({ name: SERVER, version: '1.0.0', tools: [proposeAdvance] }),
    allowed: [`mcp__${SERVER}__propose_advance`],
  };
}
