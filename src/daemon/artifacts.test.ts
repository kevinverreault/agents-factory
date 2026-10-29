// Seam 1: artifact capture. The `hook` CLI relays each PostToolUse hook event
// of a run to the daemon, which links what the run wrote or printed to its
// task, without the agent's cooperation.
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { relayHook } from '../hooks/relay.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

// A factory with one HITL task, T1, in conversation on run R1.
async function conversing(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched; worktree: string; hook: Hook }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });
  const { sessionId, cwd } = factory.executor.started[0]!;
  const worktree = cwd!;
  // What Claude Code pipes to the `hook` CLI after a tool call in the run.
  const hook: Hook = (tool_name, tool_input, tool_response = '') =>
    relayHook(
      JSON.stringify({ session_id: sessionId, cwd: worktree, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response }),
      factory.paths,
    );
  return { factory, operator, tui, worktree, hook };
}

type Hook = (tool: string, input: Record<string, unknown>, response?: unknown) => Promise<void>;

const artifactsOf = (state: FactoryState) => Object.values(state.artifacts);
// Whether the task's first artifact, a file, is committed.
const committed = (state: FactoryState) => {
  const [artifact] = artifactsOf(state);
  return artifact?.kind === 'file' ? artifact.committed : undefined;
};

describe('file artifacts', () => {
  test('writing GLOSSARY.md or an ADR during a run adds an uncommitted artifact to the task', async () => {
    const { factory, tui, worktree, hook } = await conversing();

    factory.git.editFile(worktree, 'GLOSSARY.md');
    await hook('Write', { file_path: join(worktree, 'GLOSSARY.md'), content: '# Widgets\n' });
    factory.git.editFile(worktree, 'docs/adr/0001-sso-cookies.md');
    await hook('Edit', { file_path: join(worktree, 'docs', 'adr', '0001-sso-cookies.md'), old_string: 'a', new_string: 'b' });

    const state = await tui.until((state) => artifactsOf(state).length === 2);
    expect(artifactsOf(state)).toEqual([
      { id: 'X1', taskId: 'T1', runId: 'R1', kind: 'file', path: 'GLOSSARY.md', committed: false },
      { id: 'X2', taskId: 'T1', runId: 'R1', kind: 'file', path: 'docs/adr/0001-sso-cookies.md', committed: false },
    ]);
  });

  test('a file artifact shows committed once the worktree commits it, and uncommitted again when it is next written', async () => {
    const { factory, tui, worktree, hook } = await conversing();
    factory.git.editFile(worktree, 'GLOSSARY.md');
    await hook('Write', { file_path: join(worktree, 'GLOSSARY.md'), content: '# Widgets\n' });

    factory.git.commitAll(worktree);
    await hook('Bash', { command: 'git commit -am "Settle the glossary"' }, { stdout: '[factory/T1 c0ffee] Settle the glossary' });
    expect(artifactsOf(await tui.until((state) => committed(state) === true))).toHaveLength(1);

    factory.git.editFile(worktree, 'GLOSSARY.md');
    await hook('Edit', { file_path: join(worktree, 'GLOSSARY.md'), old_string: 'Widgets', new_string: 'Widget shop' });
    expect(artifactsOf(await tui.until((state) => committed(state) === false))).toEqual([
      { id: 'X1', taskId: 'T1', runId: 'R1', kind: 'file', path: 'GLOSSARY.md', committed: false },
    ]);
  });

  test('other files, a glossary below the top level and files outside the worktree are no artifacts', async () => {
    const { operator, tui, worktree, hook } = await conversing();

    await hook('Write', { file_path: join(worktree, 'src', 'auth', 'sso.ts'), content: '' });
    await hook('Write', { file_path: join(worktree, 'docs', 'GLOSSARY.md'), content: '' });
    await hook('Write', { file_path: join(worktree, 'docs', 'adr-notes.md'), content: '' });
    await hook('Write', { file_path: resolve('/clones/widgets/GLOSSARY.md'), content: '' });
    await hook('Read', { file_path: join(worktree, 'GLOSSARY.md') }, { file: { content: '# Widgets' } });

    await operator.send({ type: 'daemon.status' });
    expect(tui.state().artifacts).toEqual({});
  });
});

describe('issue artifacts', () => {
  test('an issue URL a tool prints, such as `gh issue create`’s, adds one issue artifact to the task', async () => {
    const { tui, hook } = await conversing();

    await hook(
      'Bash',
      { command: 'gh issue create --title "Spec: SSO login" --body-file spec.md' },
      { stdout: '\nCreating issue in acme/widgets\n\nhttps://github.com/acme/widgets/issues/41\n', stderr: '' },
    );
    await hook(
      'mcp__github__create_issue',
      { title: 'Ticket: cookie fallback' },
      [{ type: 'text', text: '{"number":42,"html_url":"https://github.com/acme/widgets/issues/42"}' }],
    );
    await hook('Bash', { command: 'gh issue view 41' }, { stdout: 'https://github.com/acme/widgets/issues/41#issuecomment-9' });

    const state = await tui.until((state) => artifactsOf(state).length === 2);
    expect(artifactsOf(state)).toEqual([
      { id: 'X1', taskId: 'T1', runId: 'R1', kind: 'issue', url: 'https://github.com/acme/widgets/issues/41' },
      { id: 'X2', taskId: 'T1', runId: 'R1', kind: 'issue', url: 'https://github.com/acme/widgets/issues/42' },
    ]);
  });

  test('an issue URL in a file the run reads or writes is no artifact: the tool only echoes the file', async () => {
    const { operator, tui, worktree, hook } = await conversing();
    const adr = join(worktree, 'docs', 'adr', '0001-sso-cookies.md');
    const content = 'Decided in [Why cookies?](https://github.com/acme/widgets/issues/7).\n';

    await hook('Write', { file_path: adr, content }, { type: 'create', filePath: adr, content });
    await hook('Read', { file_path: join(worktree, 'README.md') }, { file: { content: 'See https://github.com/acme/widgets/issues/8' } });

    await operator.send({ type: 'daemon.status' });
    expect(artifactsOf(tui.state())).toEqual([expect.objectContaining({ kind: 'file', path: 'docs/adr/0001-sso-cookies.md' })]);
  });
});

test('a task’s artifacts are in the factory-state snapshot, across a daemon restart', async () => {
  const { factory, tui, worktree, hook } = await conversing();
  factory.git.editFile(worktree, 'GLOSSARY.md');
  await hook('Write', { file_path: join(worktree, 'GLOSSARY.md'), content: '# Widgets\n' });
  await hook('Bash', { command: 'gh issue create' }, { stdout: 'https://github.com/acme/widgets/issues/41\n' });
  const before = await tui.until((state) => artifactsOf(state).length === 2);

  await factory.restart();
  const again = watch(await factory.attach());

  expect((await again.until(() => true)).artifacts).toEqual(before.artifacts);
});

test('a hook event from a session with no live run, or with no daemon to hear it, is dropped quietly', async () => {
  const { factory, operator, tui, worktree, hook } = await conversing();
  const stray = JSON.stringify({
    session_id: 'not-a-factory-session',
    cwd: worktree,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'gh issue create' },
    tool_response: 'https://github.com/acme/widgets/issues/41',
  });

  await relayHook(stray, factory.paths);
  await relayHook('not json', factory.paths);
  await operator.send({ type: 'cancel', taskId: 'T1' });
  await hook('Bash', { command: 'gh issue create' }, 'https://github.com/acme/widgets/issues/41');
  await operator.send({ type: 'daemon.status' });
  expect(tui.state().artifacts).toEqual({});

  await factory.daemon().stop();
  await expect(hook('Bash', { command: 'gh issue create' }, 'https://github.com/acme/widgets/issues/42')).resolves.toBeUndefined();
});
