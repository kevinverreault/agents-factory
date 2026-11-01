// The per-run factory MCP server: the factory's own tools, which a run's
// agent calls as `mcp__factory__<tool>`. Each reports a run event; the daemon
// decides what it means. A HITL run gets `propose_advance`, `propose_handoff`
// and `write_handoff_brief`; the delegation tools join with their own slices.
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
  const proposeHandoff = tool(
    'propose_handoff',
    'Propose handing this task off to an unattended AFK run, once what is left is work an agent can do alone. ' +
      'Only the operator hands off: they see your proposal and hand off when they are ready. Keep the conversation going meanwhile.',
    { reason: z.string().describe('Why the rest can go unattended, in one sentence.') },
    async ({ reason }) => {
      sink.report({ type: 'handoffProposed', runId, reason });
      return { content: [{ type: 'text', text: 'The operator sees your proposal and will hand off when they are ready.' }] };
    },
  );
  const items = (what: string) => z.array(z.string()).describe(what);
  const writeHandoffBrief = tool(
    'write_handoff_brief',
    'Write the handoff brief the factory asked for: what the AFK run that carries this task on starts from. ' +
      'Only what you and the operator agreed. The operator reviews and edits it before handing off.',
    {
      goal: z.string().describe('What the work achieves, in a sentence or two.'),
      decided: items('Each decision you and the operator made.'),
      doneWhen: items('Each check that says the work is done.'),
      outOfScope: items('Each thing the work must leave alone.'),
      links: items('Issue refs (owner/name#n), file paths or URLs the work relies on.'),
    },
    async (brief) => {
      sink.report({ type: 'briefWritten', runId, brief });
      return { content: [{ type: 'text', text: 'The brief is on the operator’s handoff sheet. End your turn now.' }] };
    },
  );
  const tools = [proposeAdvance, proposeHandoff, writeHandoffBrief];
  return {
    server: createSdkMcpServer({ name: SERVER, version: '1.0.0', tools }),
    allowed: tools.map(({ name }) => `mcp__${SERVER}__${name}`),
  };
}
