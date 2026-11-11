// Seam 3: the factory's code intelligence plugin in real runs. It loads, its
// LSP tool answers from the pinned `typescript-language-server`, and an L1 run
// sees the type error its edit introduces, with nothing installed globally.
// Spends a little subscription usage on haiku.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildLspPlugin, hostTypeScriptServer } from '../code-intelligence/code-intelligence.ts';
import type { RunEvent } from '../lifecycle/lifecycle.ts';
import { waitFor } from '../os/test-support.ts';
import { FACTORY_ALLOW_LIST, type ToolCall } from '../permissions/permissions.ts';
import { agentSdkExecutor } from './agent-sdk.ts';
import type { ConversationEvent } from './executor.ts';
import { afkRun, afkRunOptions, CODE_INTELLIGENCE_ERROR, CODE_INTELLIGENCE_TASK, streamedInput, typeScriptProject, typesOf } from './sdk-test-support.ts';

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lsp-project-'));
  for (const [name, content] of Object.entries(typeScriptProject())) writeFileSync(join(dir, name), content);
  return dir;
}

const hostPlugin = () => buildLspPlugin(mkdtempSync(join(tmpdir(), 'factory-lsp-')), hostTypeScriptServer());

describe('TypeScript code intelligence plugin', () => {
  test('loads in a run, and its LSP tool answers from the pinned language server', async () => {
    const input = streamedInput();
    const messages: SDKMessage[] = [];
    const run = query({
      prompt: input.messages,
      options: {
        ...afkRunOptions(projectDir()),
        tools: ['LSP'],
        allowedTools: ['LSP'],
        maxTurns: 4,
        plugins: [{ type: 'local', path: hostPlugin() }],
      },
    });
    input.send('Use the LSP tool to list the symbols in math.ts (a document symbol lookup). Then reply with the symbol names, comma separated, and nothing else.');
    for await (const message of run) {
      messages.push(message);
      if (message.type === 'result') input.close();
    }

    const init = messages.find((message) => message.type === 'system' && message.subtype === 'init');
    if (init?.type !== 'system' || init.subtype !== 'init') throw new Error('The run sent no init.');
    expect(init.plugins.map((loaded) => loaded.name)).toContain('factory-lsp');
    expect(init.plugin_errors ?? []).toEqual([]);
    expect(init.tools).toContain('LSP');

    const calls = messages.flatMap((message) =>
      message.type === 'assistant' ? message.message.content.flatMap((block) => (block.type === 'tool_use' && block.name === 'LSP' ? [block.id] : [])) : [],
    );
    expect(calls.length).toBeGreaterThan(0);
    const results = messages.flatMap((message) =>
      message.type === 'user' && Array.isArray(message.message.content)
        ? message.message.content.flatMap((block) => (block.type === 'tool_result' && calls.includes(block.tool_use_id) ? [block] : []))
        : [],
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => !result.is_error)).toBe(true);
    expect(JSON.stringify(results)).toContain('double');
    expect(JSON.stringify(results)).toContain('four');
  });

  test('an L1 run looks up symbols through the LSP tool without asking, and sees the type error its edit introduces', async () => {
    const executor = agentSdkExecutor({ lspPlugin: hostPlugin() });
    const reported: RunEvent[] = [];
    const live: ConversationEvent[] = [];
    const asked: ToolCall[] = [];
    // The pause after the edit is allowed without asking.
    const run = afkRun(projectDir(), CODE_INTELLIGENCE_TASK, 10, [...FACTORY_ALLOW_LIST, 'Bash(sleep *)']);

    executor.start(run, { report: (event) => reported.push(event), converse: (event) => live.push(event), askPermission: (call) => asked.push(call) });
    await waitFor(() => reported.some((event) => event.type === 'runCompleted' || event.type === 'runFailed'), 150_000);

    expect(typesOf(reported)).toEqual(['runStarted', 'runCompleted']);
    expect(asked).toEqual([]);
    expect(live).toContainEqual(expect.objectContaining({ type: 'toolUse', tool: 'LSP' }));
    expect(live).toContainEqual(expect.objectContaining({ type: 'toolUse', tool: 'Edit' }));
    expect(live.at(-1)).toMatchObject({ type: 'message', from: 'agent', text: expect.stringContaining(CODE_INTELLIGENCE_ERROR) });
  });
});
