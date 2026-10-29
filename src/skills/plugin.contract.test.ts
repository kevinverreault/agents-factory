// Seam 3: a factory-built skill set loads as the local plugin `factory`, and
// its skills dispatch and call one another (ADR 0005). Spends a little
// subscription usage on haiku, and fetches mattpocock/skills from GitHub.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afkRunOptions, streamedInput } from '../executor/sdk-test-support.ts';
import { buildPlugin } from './plugin.ts';
import { skillSetManager } from './skill-set.ts';

const skills = [
  {
    name: 'skeleton-echo',
    description: 'Echoes its arguments. Only use when invoked explicitly.',
    body: 'Reply with exactly `SKELETON-ECHO: $ARGUMENTS` and nothing else.',
  },
  {
    // Upstream skills name each other bare ("use the research skill").
    name: 'skeleton-caller',
    description: 'Calls skeleton-callee. Only use when invoked explicitly.',
    body: 'Invoke the `skeleton-callee` skill with the arguments `ping`, then follow its instructions exactly.',
  },
  {
    name: 'skeleton-callee',
    description: 'Answers a ping from skeleton-caller. Only use when another skill asks for it.',
    body: 'Reply with exactly `CALLEE-OK: $ARGUMENTS` and nothing else.',
  },
];

// One AFK run over the plugin, in an empty project so only the plugin's skills exist.
async function runPrompt(prompt: string, plugin = buildPlugin(mkdtempSync(join(tmpdir(), 'factory-plugin-')), skills)) {
  const input = streamedInput();
  const messages: SDKMessage[] = [];
  const run = query({
    prompt: input.messages,
    options: {
      ...afkRunOptions(mkdtempSync(join(tmpdir(), 'factory-plugin-run-'))),
      tools: ['Skill'],
      allowedTools: ['Skill'],
      maxTurns: 4,
      plugins: [{ type: 'local', path: plugin }],
    },
  });
  input.send(prompt);
  for await (const message of run) {
    messages.push(message);
    if (message.type === 'result') input.close();
  }
  const init = messages.find((message) => message.type === 'system' && message.subtype === 'init');
  const result = messages.find((message) => message.type === 'result');
  const skillCalls = messages.flatMap((message) =>
    message.type === 'assistant'
      ? message.message.content.flatMap((block) =>
          block.type === 'tool_use' && block.name === 'Skill' ? [String((block.input as { skill?: unknown }).skill)] : [],
        )
      : [],
  );
  return {
    init: init?.type === 'system' && init.subtype === 'init' ? init : undefined,
    result: result?.type === 'result' && result.subtype === 'success' ? result.result : undefined,
    skillCalls,
  };
}

describe('factory skill set as a local plugin', () => {
  test('the plugin loads and `/factory:<skill> args` dispatches with its arguments', async () => {
    const { init, result } = await runPrompt('/factory:skeleton-echo alpha beta');

    expect(init?.plugins.map((plugin) => plugin.name)).toContain('factory');
    expect(init?.plugin_errors ?? []).toEqual([]);
    expect(init?.slash_commands).toContain('factory:skeleton-echo');
    expect(result).toContain('SKELETON-ECHO: alpha beta');
  });

  test('a skill that names another skill bare reaches it inside the plugin', async () => {
    const { result, skillCalls } = await runPrompt('/factory:skeleton-caller');

    expect(skillCalls).toHaveLength(1);
    expect(skillCalls[0]).toMatch(/^(factory:)?skeleton-callee$/);
    expect(result).toContain('CALLEE-OK: ping');
  });

  test('the skill set built from the default pin loads every upstream skill as `/factory:<skill>`', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-skill-set-'));
    const skillSets = skillSetManager({ root: join(home, 'skills'), lockPath: join(home, 'skills.lock') });
    const { path } = await skillSets.current();

    const { init } = await runPrompt('Reply with exactly OK and nothing else.', path);

    expect(init?.plugins.map((plugin) => plugin.name)).toContain('factory');
    expect(init?.plugin_errors ?? []).toEqual([]);
    expect(init?.slash_commands).toEqual(
      expect.arrayContaining(['factory:implement', 'factory:research', 'factory:wayfinder', 'factory:setup-matt-pocock-skills']),
    );
  }, 180_000);
});
