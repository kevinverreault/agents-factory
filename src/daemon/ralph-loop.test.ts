// Seam 1: the Ralph loop (ADR 0006). The implement stage's loop re-reads its
// ticket set from GitHub before every iteration, runs the first unblocked
// ticket in sub-issue order in a fresh session on the task branch, judges the
// iteration, and closes a successful ticket as the factory's App with a token
// narrowed to that write. It holds its slot between iterations and ends once
// every ticket is closed.
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { handOff } from '../testing/handoff.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const READY = ['ready-for-agent'];

// A factory with the spec acme/widgets#10 on GitHub, whose sub-issues are
// the tickets #11, #12 and #13 in that order, #13 not ready for an agent.
async function withSpec(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const { github } = factory;
  github.addIssue('acme/widgets#10');
  github.addIssue('acme/widgets#11', { parent: 'acme/widgets#10', labels: READY });
  github.addIssue('acme/widgets#12', { parent: 'acme/widgets#10', labels: READY });
  github.addIssue('acme/widgets#13', { parent: 'acme/widgets#10', labels: ['needs-triage'] });
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

// main-flow launched at its implement loop on the spec.
async function looping(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const attached = await withSpec();
  const launched = await attached.operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', issues: ['#10'] });
  if (!launched.ok) throw new Error(launched.reason);
  await attached.tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  return attached;
}

// The agent commits a change to each of `paths` in the worktree, one commit
// each, and returns the commits.
async function commit(factory: TestFactory, worktree: string, ...paths: string[]): Promise<string[]> {
  const commits: string[] = [];
  for (const path of paths) {
    factory.git.editFile(worktree, path);
    factory.git.commitAll(worktree);
    commits.push((await factory.git.snapshot(worktree)).head);
  }
  return commits;
}

describe('picking the ticket', () => {
  test('the first iteration is a fresh session on the first ready ticket in sub-issue order, told its context', async () => {
    const { factory, tui } = await looping();

    const [first] = factory.executor.started;
    const { worktree, branch } = tui.state().tasks.T1!;
    expect(first).toMatchObject({ runId: 'R1', mode: 'AFK', resumesSession: false, cwd: worktree });
    expect(first!.firstMessage).toMatch(/^\/factory:implement acme\/widgets#11\n\n/);
    expect(first!.firstMessage).toContain(branch!);
    expect(first!.firstMessage).toContain('acme/widgets#10');
    expect(tui.state().runs.R1).toMatchObject({ stage: 'implement', ticket: 'acme/widgets#11' });
  });
});

describe('a successful iteration', () => {
  test('closes its ticket as completed, with a token for that write alone and a comment naming the branch, commits and task', async () => {
    const { factory, tui } = await looping();
    const { worktree, branch } = tui.state().tasks.T1!;
    const commits = await commit(factory, worktree!, 'src/logout.ts', 'src/session.ts');

    factory.executor.report('R1', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(factory.github.issueState('acme/widgets#11')).toMatchObject({ open: false, stateReason: 'completed' });
    const [close] = factory.github.writes;
    expect(close).toMatchObject({ action: 'close', ref: 'acme/widgets#11', token: { repo: 'acme/widgets', permissions: { issues: 'write', metadata: 'read' } } });
    // Its own token, minted for this write: no other call used it.
    expect(factory.github.minted.filter(({ token }) => token === close!.token.token)).toHaveLength(1);
    expect(close!.comment).toContain(branch!);
    expect(close!.comment).toContain('T1');
    for (const made of commits) expect(close!.comment).toContain(made.slice(0, 7));
    expect(tui.state().tasks.T1?.closedTickets).toEqual([{ ref: 'acme/widgets#11', commits }]);
  });

  test('is followed by a fresh session on the next ticket, told what is done', async () => {
    const { factory, tui } = await looping();
    const commits = await commit(factory, tui.state().tasks.T1!.worktree!, 'src/logout.ts');

    factory.executor.report('R1', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    const [first, second] = factory.executor.started;
    expect(second).toMatchObject({ runId: 'R2', resumesSession: false, cwd: first!.cwd });
    expect(second!.sessionId).not.toBe(first!.sessionId);
    expect(second!.firstMessage).toMatch(/^\/factory:implement acme\/widgets#12\n\n/);
    expect(second!.firstMessage).toContain(`acme/widgets#11: ${commits[0]!.slice(0, 7)}`);
    expect(second!.firstMessage).toContain('1 of 2 tickets closed');
    expect(tui.state().runs.R2).toMatchObject({ ticket: 'acme/widgets#12' });
  });
});

describe('the next pick', () => {
  test('is re-read from GitHub before every iteration: reordering the sub-issues changes it', async () => {
    const { factory, operator, tui } = await withSpec();
    factory.github.addIssue('acme/widgets#14', { parent: 'acme/widgets#10', labels: READY });
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', issues: ['#10'] });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    await commit(factory, tui.state().tasks.T1!.worktree!, 'src/logout.ts');

    factory.github.reorder('acme/widgets#10', ['acme/widgets#11', 'acme/widgets#14', 'acme/widgets#12', 'acme/widgets#13']);
    factory.executor.report('R1', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(tui.state().runs.R2).toMatchObject({ ticket: 'acme/widgets#14' });
  });

  test('skips a ticket with an open blocker, and a stalled loop asks the operator', async () => {
    const factory = await startTestFactory();
    factories.push(factory);
    await factory.registerRepo();
    factory.github.addIssue('acme/widgets#10');
    factory.github.addIssue('acme/widgets#20');
    factory.github.addIssue('acme/widgets#11', { parent: 'acme/widgets#10', labels: READY, blockedBy: ['acme/widgets#12'] });
    factory.github.addIssue('acme/widgets#12', { parent: 'acme/widgets#10', labels: READY, blockedBy: ['acme/widgets#20'] });
    const operator = await factory.attach();
    const tui = watch(operator);
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', issues: ['#10'] });

    const stalled = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(stalled.attentionQueue).toMatchObject([
      {
        attention: 'stage-blocked',
        reason: 'implement’s loop stalled: every open ticket is blocked (acme/widgets#11 by acme/widgets#12; acme/widgets#12 by acme/widgets#20).',
      },
    ]);
    expect(factory.executor.started).toEqual([]);

    factory.github.close('acme/widgets#20');
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    expect(tui.state().runs.R1).toMatchObject({ ticket: 'acme/widgets#12' });
  });
});

describe('a spec with no ready tickets', () => {
  test('is never a ticket itself: the loop asks the operator instead', async () => {
    const factory = await startTestFactory();
    factories.push(factory);
    await factory.registerRepo();
    factory.github.addIssue('acme/widgets#10', { labels: READY });
    const operator = await factory.attach();
    const tui = watch(operator);
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'tickets', issues: ['#10'] });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');

    await handOff(operator, tui, factory.executor, 'T1');

    const blocked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(blocked.tasks.T1).toMatchObject({ mode: 'AFK', stage: 'implement' });
    expect(blocked.attentionQueue).toMatchObject([
      { attention: 'stage-blocked', reason: 'implement has no tickets: acme/widgets#10 hold no open issue labelled ready-for-agent.' },
    ]);
    expect(factory.executor.started.map(({ runId }) => runId)).toEqual(['R1']);
  });
});

describe('an iteration that fails the judgement', () => {
  test('with no new commit doesn’t close its ticket, and retrying resumes that ticket’s session', async () => {
    const { factory, operator, tui } = await looping();

    factory.executor.report('R1', { type: 'runCompleted' });

    const failed = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(failed.attentionQueue).toMatchObject([
      { attention: 'failure', reason: `The iteration on acme/widgets#11 made no new commit on ${failed.tasks.T1!.branch}, so the ticket stays open.` },
    ]);
    expect(factory.github.issueState('acme/widgets#11').open).toBe(true);
    expect(factory.github.writes).toEqual([]);

    await operator.send({ type: 'answer', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    const [first, retry] = factory.executor.started;
    expect(retry).toMatchObject({ resumesSession: true, sessionId: first!.sessionId });
    expect(tui.state().runs.R2).toMatchObject({ ticket: 'acme/widgets#11' });

    await commit(factory, tui.state().tasks.T1!.worktree!, 'src/logout.ts');
    factory.executor.report('R2', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    expect(factory.github.issueState('acme/widgets#11').open).toBe(false);
  });

  test('that left the tree dirty doesn’t close its ticket, even with a commit', async () => {
    const { factory, tui } = await looping();
    const worktree = tui.state().tasks.T1!.worktree!;
    await commit(factory, worktree, 'src/logout.ts');

    factory.git.breakInvariant(worktree, 'The run left uncommitted changes: src/session.ts.');
    factory.executor.report('R1', { type: 'runCompleted' });

    const failed = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(failed.attentionQueue).toMatchObject([{ attention: 'failure', reason: expect.stringContaining('uncommitted changes') }]);
    expect(factory.github.issueState('acme/widgets#11').open).toBe(true);
    expect(failed.tasks.T1?.closedTickets).toEqual([]);
  });
});

describe('the slot', () => {
  test('is held by the loop between iterations: a queued task doesn’t take it', async () => {
    const { factory, operator, tui } = await withSpec();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', issues: ['#10'] });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: 'Fix #45' });
    await tui.until((state) => state.tasks.T2?.label === 'Queued');
    await commit(factory, tui.state().tasks.T1!.worktree!, 'src/logout.ts');

    factory.executor.report('R1', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(factory.executor.started.map(({ taskId }) => taskId)).toEqual(['T1', 'T1']);
    expect(tui.state().tasks.T2?.label).toBe('Queued');
    expect(tui.state().slots).toEqual({ active: 1, cap: 1 });
  });
});

describe('a failed GitHub write', () => {
  test('raises github-write, and the ticket closes as the App once the operator fixes it and answers', async () => {
    const { factory, operator, tui } = await looping();
    await commit(factory, tui.state().tasks.T1!.worktree!, 'src/logout.ts');
    factory.github.uninstall('acme/widgets');

    factory.executor.report('R1', { type: 'runCompleted' });

    const failed = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(failed.attentionQueue).toMatchObject([
      {
        attention: 'github-write',
        reason:
          'The factory couldn’t close acme/widgets#11 on GitHub as its App: The factory’s App isn’t installed on acme/widgets. Fix it, then answer to try again.',
      },
    ]);
    // Nothing wrote it some other way meanwhile.
    expect(factory.github.issueState('acme/widgets#11')).toMatchObject({ open: true, comments: [] });

    factory.github.install('acme/widgets');
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(factory.github.issueState('acme/widgets#11')).toMatchObject({ open: false, stateReason: 'completed' });
    expect(factory.github.writes).toMatchObject([{ ref: 'acme/widgets#11', token: { permissions: { issues: 'write' } } }]);
    expect(tui.state().runs.R2).toMatchObject({ ticket: 'acme/widgets#12' });
  });
});

describe('taking the loop over', () => {
  test('mid-iteration, the operator works the ticket: handing back picks afresh from GitHub', async () => {
    const { factory, operator, tui } = await looping();

    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    await handOff(operator, tui, factory.executor, 'T1');

    await tui.until((state) => state.tasks.T1?.mode === 'AFK' && state.tasks.T1.liveRunId === 'R3');
    expect(tui.state().runs.R3).toMatchObject({ mode: 'AFK', ticket: 'acme/widgets#11' });
    expect(factory.github.writes).toEqual([]);
  });

  test('with its ticket’s close failed, handing back closes the ticket the iteration did before the next pick', async () => {
    const { factory, operator, tui } = await looping();
    const commits = await commit(factory, tui.state().tasks.T1!.worktree!, 'src/logout.ts');
    factory.github.uninstall('acme/widgets');
    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    factory.github.install('acme/widgets');
    await handOff(operator, tui, factory.executor, 'T1');

    await tui.until((state) => state.tasks.T1?.mode === 'AFK' && state.tasks.T1.liveRunId === 'R3');
    expect(factory.github.issueState('acme/widgets#11')).toMatchObject({ open: false, stateReason: 'completed' });
    expect(tui.state().tasks.T1?.closedTickets).toEqual([{ ref: 'acme/widgets#11', commits }]);
    expect(tui.state().runs.R3).toMatchObject({ ticket: 'acme/widgets#12' });
  });
});

describe('the end of the stage', () => {
  test('comes once every ticket is closed: tickets-closed holds and the next stage starts', async () => {
    const { factory, tui } = await looping();
    const worktree = tui.state().tasks.T1!.worktree!;
    await commit(factory, worktree, 'src/logout.ts');
    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    await commit(factory, worktree, 'src/session.ts');

    factory.executor.report('R2', { type: 'runCompleted' });

    const reviewing = await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    expect(reviewing.tasks.T1).toMatchObject({ stage: 'review', label: 'Running' });
    expect(reviewing.runs.R3).toMatchObject({ stage: 'review', ticket: null });
    expect(factory.executor.started.at(-1)!.firstMessage).toBe('/factory:code-review');
    expect(reviewing.tasks.T1!.closedTickets.map(({ ref }) => ref)).toEqual(['acme/widgets#11', 'acme/widgets#12']);
    // The ticket not ready for an agent was never worked.
    expect(factory.github.issueState('acme/widgets#13').open).toBe(true);
  });
});

describe('with no ticket set', () => {
  test('an early handoff runs implement once from the brief, and its run completing ends the stage', async () => {
    const { factory, operator, tui } = await withSpec();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', prompt: 'Add a logout button.' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');

    await handOff(operator, tui, factory.executor, 'T1');

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(tui.state().tasks.T1).toMatchObject({ mode: 'AFK', stage: 'implement' });
    expect(factory.executor.started.at(-1)!.firstMessage).toBe('/factory:implement\n\n# Handoff brief\n\nCarry the work on.');

    factory.executor.report('R2', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    expect(tui.state().tasks.T1?.stage).toBe('review');
    expect(tui.state().attentionQueue).toEqual([]);
    expect(factory.github.writes).toEqual([]);
  });
});
