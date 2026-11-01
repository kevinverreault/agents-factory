// Seam 1: the AFK git guards (ADR 0007) through the client protocol. Every AFK
// run starts guarded, from its worktree's tip and in a cleaned git
// environment, and is checked against that tip once it ends: a broken
// invariant fails it with a failure attention request. HITL runs are not guarded.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const implement = (issue: string): LaunchCommand => ({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: issue });
const clone = resolve('/clones/widgets');

describe('an AFK run starts guarded', () => {
  test('from its worktree’s tip, committing as the factory’s bot, with pushes and credentials cut off', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implement('#39'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    const [worktree] = await factory.git.worktrees(clone);
    const [run] = factory.executor.started;
    expect(run!.guards).toMatchObject({
      start: worktree!.head,
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'agents-factory[bot]',
        GIT_COMMITTER_NAME: 'agents-factory[bot]',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
    });
    const gitconfig = readFileSync(run!.guards!.env.GIT_CONFIG_GLOBAL!, 'utf8');
    expect(gitconfig).toMatch(/pushInsteadOf =\s*$/m);
  });

  test('while a HITL run is not', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });
    await tui.until((state) => state.tasks.T1?.label === 'In conversation');

    expect(factory.executor.started[0]!.guards).toBeNull();
  });
});

describe('after an AFK run', () => {
  test('a run that broke an invariant fails, with a failure attention request saying what broke', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implement('#39'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');
    const [worktree] = await factory.git.worktrees(clone);

    factory.git.breakInvariant(worktree!.path, 'The run left branch main checked out instead of factory/T1-39.');
    factory.git.breakInvariant(worktree!.path, 'The run added remotes: fork.');
    factory.executor.report('R1', { type: 'runCompleted' });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(state.runs.R1).toMatchObject({ status: 'ended', outcome: 'failed' });
    expect(state.attentionQueue).toMatchObject([
      {
        attention: 'failure',
        taskId: 'T1',
        reason: 'The run broke the factory’s git guards. The run left branch main checked out instead of factory/T1-39. The run added remotes: fork.',
      },
    ]);
  });

  test('a run that failed on its own says what it broke too', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implement('#39'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');
    const [worktree] = await factory.git.worktrees(clone);

    factory.git.breakInvariant(worktree!.path, 'The run left uncommitted changes: src/login.ts.');
    factory.executor.report('R1', { type: 'runFailed', reason: 'The run hit its max turns (300) before it finished.' });

    const state = await tui.until((state) => state.attentionQueue.length === 1);
    expect(state.attentionQueue).toMatchObject([
      {
        attention: 'failure',
        reason:
          'The run hit its max turns (300) before it finished. It also broke the factory’s git guards. The run left uncommitted changes: src/login.ts.',
      },
    ]);
  });

  test('a run that kept them reaches review, with the branches cut for other tasks meanwhile not counted against it', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implement('#39'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');
    await operator.send(implement('#40'));
    await tui.until((state) => state.tasks.T2?.label === 'Running');
    const worktrees = await factory.git.worktrees(clone);

    factory.executor.report('R1', { type: 'runCompleted' });

    const state = await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(state.attentionQueue).toMatchObject([{ kind: 'review', taskId: 'T1' }]);
    expect(factory.git.checked).toEqual([{ worktreePath: worktrees[0]!.path, branches: [worktrees[1]!.branch] }]);
  });
});
