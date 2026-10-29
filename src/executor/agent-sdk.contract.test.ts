// Seam 3: the Agent SDK on the operator's Windows machine (SDK #359, #444).
// Spends a little subscription usage on haiku.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { afkRunOptions, streamedInput } from './sdk-test-support.ts';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type SDKMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-sdk-'));
  writeFileSync(join(dir, 'secret.txt'), 'the word is PERIWINKLE-42\n');
  return dir;
}

// The agent gets Bash only, and may run only the one command the test expects.
function onlyCommand(expected: string, asked: string[]): CanUseTool {
  return async (toolName, toolInput) => {
    asked.push(toolName);
    const command = String(toolInput.command ?? '').trim();
    return toolName === 'Bash' && command === expected
      ? { behavior: 'allow', updatedInput: toolInput }
      : { behavior: 'deny', message: `Only \`${expected}\` is allowed in this test.` };
  };
}

function runOptions(cwd: string, spawned: SpawnOptions[], canUseTool: CanUseTool) {
  return {
    ...afkRunOptions(cwd),
    tools: ['Bash'],
    canUseTool,
    maxTurns: 6,
    // The factory spawns every CLI itself so it can record the PID (ADR 0003).
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      spawned.push(options);
      return spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
    },
  };
}

describe('Agent SDK on Windows', () => {
  test('a run takes streamed input across turns, executes tool calls and spawns the bundled binary', async () => {
    const cwd = workspace();
    const spawned: SpawnOptions[] = [];
    const input = streamedInput();
    const asked: string[] = [];
    const run = query({
      prompt: input.messages,
      options: runOptions(cwd, spawned, onlyCommand('cp secret.txt found.txt', asked)),
    });

    input.send(
      'Use the Bash tool to run exactly `cp secret.txt found.txt`, then run `cat found.txt`, ' +
        'then reply with only the word it contains.',
    );
    const results: string[] = [];
    let toolResults = 0;
    for await (const message of run) {
      if (message.type === 'user' && Array.isArray(message.message.content)) {
        toolResults += message.message.content.filter((block) => block.type === 'tool_result').length;
      }
      if (message.type === 'result') {
        expect(message.subtype).toBe('success');
        results.push(message.subtype === 'success' ? message.result : '');
        if (results.length === 1) input.send('Reply with only the word you found, in lowercase.');
        else input.close();
      }
    }

    // Only the write reaches canUseTool: read-only Bash (`cat`, `sleep`) is auto-approved.
    expect(asked).toEqual(['Bash']);
    expect(existsSync(join(cwd, 'found.txt'))).toBe(true);
    expect(toolResults).toBeGreaterThanOrEqual(2);
    expect(results[0]).toContain('PERIWINKLE-42');
    expect(results[1]).toContain('periwinkle-42');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.command).toMatch(/claude-agent-sdk-win32-x64[\\/]claude\.exe$/);
  });

  test('interrupt() stops a turn mid-tool-call and the same run takes the next message', async () => {
    const cwd = workspace();
    const input = streamedInput();
    const asked: string[] = [];
    const run = query({
      prompt: input.messages,
      options: runOptions(cwd, [], onlyCommand('sleep 120', asked)),
    });

    input.send('Use the Bash tool to run `sleep 120`. After it finishes, say DONE-SLEEPING.');
    let interruptedAt: number | undefined;
    let cutAt: number | undefined;
    const results: Extract<SDKMessage, { type: 'result' }>[] = [];
    for await (const message of run) {
      const callsBash =
        message.type === 'assistant' &&
        message.message.content.some((block) => block.type === 'tool_use' && block.name === 'Bash');
      if (callsBash && interruptedAt === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        interruptedAt = Date.now();
        await run.interrupt();
      }
      if (message.type === 'result') {
        cutAt ??= Date.now();
        results.push(message);
        if (results.length === 1) input.send('Reply with only the word PONG.');
        else input.close();
      }
    }

    // `sleep` is read-only to Claude Code, so it ran without asking.
    expect(asked).toEqual([]);
    expect(interruptedAt).toBeDefined();
    expect(cutAt! - interruptedAt!).toBeLessThan(15_000);
    const [cut, next] = results.map((message) => ('result' in message ? message.result : message.subtype));
    expect(cut).not.toContain('DONE-SLEEPING');
    expect(next).toContain('PONG');
  });

  test('an in-process factory MCP tool is called from a streamed run', async () => {
    const statuses: string[] = [];
    const factory = createSdkMcpServer({
      name: 'factory',
      tools: [
        tool('report_progress', 'Set a one-line status on your task row.', { status: z.string() }, async ({ status }) => {
          statuses.push(status);
          return { content: [{ type: 'text', text: 'ok' }] };
        }),
      ],
    });
    const asked: string[] = [];
    const onlyFactoryTools: CanUseTool = async (toolName, toolInput) => {
      asked.push(toolName);
      return toolName.startsWith('mcp__factory__')
        ? { behavior: 'allow', updatedInput: toolInput }
        : { behavior: 'deny', message: 'Only factory tools are allowed in this test.' };
    };
    const input = streamedInput();
    const run = query({
      prompt: input.messages,
      options: { ...runOptions(workspace(), [], onlyFactoryTools), tools: [], mcpServers: { factory } },
    });

    input.send('Call the report_progress tool with status "walking skeleton", then reply DONE.');
    for await (const message of run) {
      if (message.type === 'result') input.close();
    }

    expect(asked).toEqual(['mcp__factory__report_progress']);
    expect(statuses).toEqual(['walking skeleton']);
  });
});
