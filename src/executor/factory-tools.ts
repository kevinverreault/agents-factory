// The per-run factory MCP server: the factory's own tools, which a run's
// agent calls as `mcp__factory__<tool>`. Each reports a run event; the daemon
// decides what it means. A HITL run gets `propose_advance`, `propose_handoff`
// and `write_handoff_brief`, and an AFK run `report_findings` or
// `write_pr_body` when its stage reports through them, and the delegation
// tools: `spawn_child`, `list_children`, `cancel_child` and
// `report_progress`, and `report_result` on a child's run (ADR 0009).
import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Report } from '../lifecycle/lifecycle.ts';
import { TIERS } from '../models/routing.ts';
import type { Delegation, DelegationReply, RunSink } from './executor.ts';

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

// The tools of what the AFK run reports, and the delegation tools: with
// the one a child reports to its parent through, when `child`, and
// `spawn_child` only while the run's tree `spawns` deeper.
export function afkFactoryTools(runId: string, sink: RunSink, reports: readonly Report[], { child, spawns }: { child: boolean; spawns: boolean }): FactoryTools {
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
  const tools = [
    ...(reports.includes('findings') ? [reportFindings] : []),
    ...(reports.includes('pr-body') ? [writePrBody] : []),
    ...delegationTools(runId, sink, child, spawns),
  ];
  return factoryTools(tools);
}

// The tools an AFK run delegates with (ADR 0009). Spawning, listing and
// cancelling are answered by the daemon; progress and results are run events.
function delegationTools(runId: string, sink: RunSink, child: boolean, spawns: boolean): SdkTool[] {
  const spawnChild = tool(
    'spawn_child',
    'Hand a self-contained piece of work to a child task: its own AFK run on its own branch, cut from your branch’s tip, which the operator can watch and steer. ' +
      'The child doesn’t see this conversation, so the goal must stand on its own. A fire-and-forget child’s code never joins your branch: ' +
      'its output is its report and any issues it opens. Returns the child’s id, or why it can’t be spawned (such as a depth or fan-out limit): then do the work yourself.',
    {
      goal: z.string().min(1).describe('What the child must achieve, standing on its own.'),
      skill: z.string().optional().describe('A skill of the factory’s skill set to invoke on the goal.'),
      tier: z.enum(TIERS).optional().describe('The model tier: yours or a lower one. A higher one is lowered to yours.'),
      autonomy: z.enum(['L1', 'L2']).optional().describe('The autonomy level: yours or a lower one.'),
      await: z.boolean().optional().describe('Whether you wait for its report. Only fire-and-forget children (false) are supported yet.'),
    },
    async (args, extra) => ask(sink, { type: 'spawnChild', toolUseId: toolUseIdOf(extra), ...args, await: args.await ?? false }),
  );
  const listChildren = tool(
    'list_children',
    'List the child tasks you spawned, with their state, one-line status and, once they ended, their report.',
    {},
    async () => ask(sink, { type: 'listChildren' }),
  );
  const cancelChild = tool(
    'cancel_child',
    'Cancel one of your own children, with every task it spawned.',
    { id: z.string().describe('The child task’s id, such as T7.') },
    async ({ id }) => ask(sink, { type: 'cancelChild', id }),
  );
  const reportProgress = tool(
    'report_progress',
    'Set a one-line status the operator sees on your task’s row, such as what you are working on now. It never reaches your parent.',
    { status: z.string().min(1).describe('What you are doing, in one short line.') },
    async ({ status }) => {
      sink.report({ type: 'progressReported', runId, status });
      return { content: [{ type: 'text', text: 'The operator sees your status.' }] };
    },
  );
  const reportResult = tool(
    'report_result',
    'Report your result to the task that spawned you, before you end. The factory adds your branch, commits and how the run ended. ' +
      'Calling it again replaces what you reported.',
    {
      summary: z.string().min(1).describe('What you did and found, for your parent.'),
      status: z.string().min(1).describe('How it went, in a word or two: done, partial, blocked…'),
      notes: z.string().describe('Anything else your parent should know, or nothing.'),
    },
    async ({ summary, status, notes }) => {
      sink.report({ type: 'resultReported', runId, summary, status, notes });
      return { content: [{ type: 'text', text: 'Your parent gets your report once you end.' }] };
    },
  );
  return [...(spawns ? [spawnChild] : []), listChildren, cancelChild, reportProgress, ...(child ? [reportResult] : [])];
}

// What the agent reads when its run's sink takes no delegation.
const NO_DELEGATION: DelegationReply = { ok: false, error: 'The factory takes no delegation from this run.' };

// Asks the daemon through the run's sink, and gives the agent its reply.
async function ask(sink: RunSink, request: Delegation) {
  return answer((await sink.delegate?.(request)) ?? NO_DELEGATION);
}

// The daemon's reply as the tool's result: an error the agent reads as one.
function answer(reply: DelegationReply) {
  return reply.ok
    ? { content: [{ type: 'text' as const, text: reply.text }] }
    : { content: [{ type: 'text' as const, text: reply.error }], isError: true };
}

// The SDK tool use id Claude Code sends with an MCP tool call, which keys a
// spawn so a replay finds the child it spawned (ADR 0009). Without one, the
// call is its own.
function toolUseIdOf(extra: unknown): string {
  const id = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.['claudecode/toolUseId'];
  return typeof id === 'string' && id ? id : randomUUID();
}

type SdkTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>[number];

function factoryTools(tools: SdkTool[]): FactoryTools {
  return {
    server: createSdkMcpServer({ name: SERVER, version: '1.0.0', tools }),
    allowed: tools.map(({ name }) => `mcp__${SERVER}__${name}`),
  };
}
