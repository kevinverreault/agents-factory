// The per-run factory MCP server: the factory's own tools, which a run's
// agent calls as `mcp__factory__<tool>`. Each reports a run event; the daemon
// decides what it means. A HITL run gets `propose_advance`, `propose_handoff`
// and `write_handoff_brief`, and an AFK run `report_findings` or
// `write_pr_body` when its stage reports through them (ADR 0009); the
// delegation tools join with their own slices.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Report } from '../lifecycle/lifecycle.ts';
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
  return factoryTools([proposeAdvance, proposeHandoff, writeHandoffBrief]);
}

// The tools of what the AFK run reports, or null when it reports nothing.
export function afkFactoryTools(runId: string, sink: RunSink, reports: readonly Report[]): FactoryTools | null {
  const reportFindings = tool(
    'report_findings',
    'Report the findings of this code review to the factory, one finding per item, each a sentence saying what is wrong and where. ' +
      'On the review’s fix pass, report the findings you left unfixed instead, with none if you fixed them all. ' +
      'Calling it again replaces what you reported.',
    { findings: z.array(z.string()).describe('Each finding, in a sentence.') },
    async ({ findings }) => {
      sink.report({ type: 'findingsReported', runId, findings });
      return { content: [{ type: 'text', text: 'The factory has your findings.' }] };
    },
  );
  const writePrBody = tool(
    'write_pr_body',
    'Write the body of this task’s pull request, in Markdown: the factory opens the PR with it. ' +
      'Calling it again replaces what you wrote.',
    { body: z.string().min(1).describe('The PR body, in Markdown.') },
    async ({ body }) => {
      sink.report({ type: 'prBodyWritten', runId, body });
      return { content: [{ type: 'text', text: 'The factory has the PR body.' }] };
    },
  );
  const tools = [...(reports.includes('findings') ? [reportFindings] : []), ...(reports.includes('pr-body') ? [writePrBody] : [])];
  return tools.length ? factoryTools(tools) : null;
}

type SdkTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>[number];

function factoryTools(tools: SdkTool[]): FactoryTools {
  return {
    server: createSdkMcpServer({ name: SERVER, version: '1.0.0', tools }),
    allowed: tools.map(({ name }) => `mcp__${SERVER}__${name}`),
  };
}
