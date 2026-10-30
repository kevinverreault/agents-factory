// Seam 3: artifact capture end to end on the operator's Windows machine. A
// real HITL run on haiku (it spends a little usage) writes the glossary and
// prints an issue URL; Claude Code's PostToolUse hook runs the real `hook`
// CLI, which relays both to a test daemon that knows the run's session.
import { mkdirSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import type { RunEvent } from '../lifecycle/lifecycle.ts';
import { isAlive, waitFor } from '../os/test-support.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch } from '../testing/watch.ts';
import { agentSdkExecutor } from './agent-sdk.ts';

let factory: TestFactory | null = null;
const home = process.env.AGENTS_FACTORY_HOME;

afterEach(async () => {
  if (home === undefined) delete process.env.AGENTS_FACTORY_HOME;
  else process.env.AGENTS_FACTORY_HOME = home;
  await factory?.dispose();
});

test('a HITL run’s glossary write and printed issue URL reach the daemon as artifacts through the hook CLI', async () => {
  factory = await startTestFactory();
  await factory.registerRepo();
  const tui = watch(await factory.attach());
  const operator = await factory.attach();
  await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Settle the glossary.' });
  // The fake executor stands in for the daemon's run; the real one runs the
  // same session in the same (now real) worktree.
  const started = factory.executor.started[0]!;
  const cwd = started.cwd!;
  mkdirSync(cwd, { recursive: true });
  factory.git.editFile(cwd, 'GLOSSARY.md');
  // The run's environment is the daemon's, so the hook finds this factory.
  process.env.AGENTS_FACTORY_HOME = factory.paths.home;

  const executor = agentSdkExecutor();
  const reported: RunEvent[] = [];
  executor.start(
    {
      ...started,
      model: 'claude-haiku-5-5',
      firstMessage:
        'Use the Write tool to create GLOSSARY.md containing only "# Widgets". ' +
        'Then use the Bash tool to run exactly: echo https://github.com/acme/widgets/issues/41 ' +
        'Then reply with only the word DONE.',
    },
    { report: (event) => reported.push(event), converse: () => {} },
  );
  try {
    const state = await tui.until((state) => Object.keys(state.artifacts).length === 2, 150_000);
    expect(Object.values(state.artifacts)).toEqual(
      expect.arrayContaining([
        { id: expect.any(String), taskId: 'T1', runId: 'R1', kind: 'file', path: 'GLOSSARY.md', committed: false },
        { id: expect.any(String), taskId: 'T1', runId: 'R1', kind: 'issue', url: 'https://github.com/acme/widgets/issues/41' },
      ]),
    );
  } finally {
    executor.stop(started.runId);
    // The CLI works in the worktree, so the factory home can go only once it has.
    const cli = reported.find((event) => event.type === 'runStarted');
    if (cli) await waitFor(() => !isAlive(cli.pid), 15_000);
  }
});
