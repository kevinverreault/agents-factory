// Seam 1: HITL delegation and wayfinder research children (ADR 0007, ADR
// 0009). A HITL run spawns fire-and-forget children only, and hears their
// reports as factory notes. A research child works on `research/<name>`;
// once it reports, the factory pushes that branch, only if its commits touch
// nothing but `docs/research/**`, and closes its research ticket.
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const clone = resolve('/clones/widgets');
const TICKET = 'acme/widgets#34';

// A factory with T1 launched from wayfinder, charting with the operator on
// the HITL run R1, and the research ticket acme/widgets#34 open on GitHub.
async function charting(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  factory.github.addIssue(TICKET, { title: 'Which OAuth scopes does GitHub need?', labels: ['wayfinder:research'] });
  const operator = await factory.attach();
  const tui = watch(operator);
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'wayfinder', prompt: 'Overhaul sign-in.' });
  if (!launched.ok) throw new Error(launched.reason);
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  return { factory, operator, tui };
}

let calls = 0;
function spawn(factory: TestFactory, runId: string, goal: string, more: Record<string, unknown> = {}) {
  return factory.executor.delegate(runId, { type: 'spawnChild', toolUseId: `toolu_${++calls}`, goal, ...more });
}

describe('a HITL run delegates', () => {
  test('its run may spawn children', async () => {
    const { factory } = await charting();

    expect(factory.executor.started.find((run) => run.runId === 'R1')).toMatchObject({ mode: 'HITL', spawns: true });
  });

  test('an awaited child is refused, and nothing is spawned', async () => {
    const { factory, tui } = await charting();

    expect(await spawn(factory, 'R1', 'Survey sign-in.', { await: true })).toEqual({
      ok: false,
      error: expect.stringContaining('A HITL run spawns fire-and-forget children only'),
    });
    expect(Object.keys(tui.state().tasks)).toEqual(['T1']);
  });

  test('a fire-and-forget child is spawned, by default', async () => {
    const { factory, tui } = await charting();

    expect(await spawn(factory, 'R1', 'Survey sign-in.')).toMatchObject({ ok: true });

    const state = await tui.until((state) => !!state.tasks.T2?.liveRunId);
    expect(state.tasks.T2).toMatchObject({ parent: 'T1', mode: 'AFK', child: { awaited: false } });
  });
});

// The run's agent spawns a research child on the ticket, named `name`.
function spawnResearch(factory: TestFactory, runId: string, name = 'oauth-scopes', more: Record<string, unknown> = {}) {
  return spawn(factory, runId, 'Find which OAuth scopes GitHub needs for sign-in.', { skill: 'research', research: { ticket: '#34', name }, ...more });
}

describe('spawning a research child', () => {
  test('it works on research/<name>, cut from the base branch, fire-and-forget at L1, told where its findings go', async () => {
    const { factory, tui } = await charting();
    const parentTree = tui.state().tasks.T1!.worktree!;
    factory.git.editFile(parentTree, 'src/sign-in.ts');
    factory.git.commitAll(parentTree);

    expect(await spawnResearch(factory, 'R1')).toEqual({ ok: true, text: expect.stringContaining('Spawned T2 on research/oauth-scopes.') });

    const state = await tui.until((state) => !!state.tasks.T2?.liveRunId);
    expect(state.tasks.T2).toMatchObject({ parent: 'T1', branch: 'research/oauth-scopes', autonomy: 'L1', child: { awaited: false } });
    const child = (await factory.git.worktrees(clone)).find((found) => found.branch === 'research/oauth-scopes')!;
    // Nothing of the parent's branch rides along to GitHub.
    expect(factory.git.branchTip(clone, 'research/oauth-scopes')).toBe(factory.git.originTip(clone, 'main'));
    expect(child.head).toBe(factory.git.originTip(clone, 'main'));
    const started = factory.executor.started.find((run) => run.taskId === 'T2')!;
    expect(started.firstMessage).toMatch(/^\/factory:research Find which OAuth scopes/);
    expect(started.firstMessage).toContain(`research ticket ${TICKET}`);
    expect(started.firstMessage).toContain('docs/research/');
  });

  test('a name that can’t be a branch, or a ticket of another repository, is refused', async () => {
    const { factory, tui } = await charting();

    expect(await spawnResearch(factory, 'R1', 'no spaces/or..dots')).toEqual({ ok: false, error: expect.stringContaining('research/') });
    expect(await spawn(factory, 'R1', 'Survey.', { research: { ticket: 'other/repo#3', name: 'survey' } })).toEqual({
      ok: false,
      error: expect.stringContaining('acme/widgets'),
    });
    expect(Object.keys(tui.state().tasks)).toEqual(['T1']);
  });
});

const minutes = (n: number) => n * 60_000;

describe('a HITL parent hears its child’s report as a factory note', () => {
  // T1's R1 spawns the fire-and-forget child T2, live on R2.
  async function withChild() {
    const charted = await charting();
    await spawn(charted.factory, 'R1', 'Survey sign-in.');
    await charted.tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    return charted;
  }

  function childReports(factory: TestFactory) {
    factory.executor.report('R2', { type: 'resultReported', summary: 'Sign-in uses the device flow.', status: 'done', notes: 'See the docs.' });
    factory.executor.report('R2', { type: 'runCompleted' });
  }

  const notesTo = (factory: TestFactory, runId: string) => factory.executor.sent.filter((sent) => sent.runId === runId && sent.text.includes('## Factory note'));

  test('on the operator’s turn, at once', async () => {
    const { factory, tui } = await withChild();
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.turn === 'operator');

    childReports(factory);

    await tui.until((state) => state.runs.R1?.turn === 'agent');
    const [note] = notesTo(factory, 'R1');
    expect(note?.text).toContain('T2');
    expect(note?.text).toContain('Sign-in uses the device flow.');
    expect(note?.text).toContain('See the docs.');
    expect(notesTo(factory, 'R1')).toHaveLength(1);
  });

  test('mid-turn, once the agent’s turn ends', async () => {
    const { factory, tui } = await withChild();

    childReports(factory);
    await tui.until((state) => state.tasks.T2?.label === 'Done');
    expect(notesTo(factory, 'R1')).toHaveLength(0);
    factory.executor.report('R1', { type: 'turnEnded' });

    await tui.until(() => notesTo(factory, 'R1').length > 0);
    expect(notesTo(factory, 'R1')[0]!.text).toContain('Sign-in uses the device flow.');
    // Another turn's end delivers it no second time.
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.turn === 'operator');
    expect(notesTo(factory, 'R1')).toHaveLength(1);
  });

  test('parked, in the opening of its next run', async () => {
    const { factory, operator, tui } = await withChild();
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.turn === 'operator');
    factory.clock.advance(minutes(31));
    await tui.until((state) => state.runs.R1?.outcome === 'parked');

    childReports(factory);
    await tui.until((state) => state.tasks.T2?.label === 'Done');
    await operator.send({ type: 'open', taskId: 'T1' });

    await tui.until((state) => !!state.tasks.T1?.liveRunId);
    const next = factory.executor.started.find((run) => run.taskId === 'T1' && run.runId !== 'R1')!;
    expect(next.firstMessage).toContain('## Factory note');
    expect(next.firstMessage).toContain('Sign-in uses the device flow.');
  });

  test('a cancelled child’s note says so', async () => {
    const { factory, operator, tui } = await withChild();
    factory.executor.report('R1', { type: 'turnEnded' });
    await tui.until((state) => state.runs.R1?.turn === 'operator');

    await operator.send({ type: 'cancel', taskId: 'T2', branch: 'discard' });

    await tui.until(() => notesTo(factory, 'R1').length > 0);
    expect(notesTo(factory, 'R1')[0]!.text).toContain('cancelled');
  });
});

describe('a research child that reports', () => {
  // T1's R1 spawns the research child T2 on #34, live on R2, whose worktree
  // gets `files` committed.
  async function researched(files: string[]) {
    const charted = await charting();
    await spawnResearch(charted.factory, 'R1');
    const state = await charted.tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    const tree = state.tasks.T2!.worktree!;
    for (const file of files) charted.factory.git.editFile(tree, file, 'Findings.\n');
    if (files.length) charted.factory.git.commitAll(tree);
    const tip = charted.factory.git.branchTip(clone, 'research/oauth-scopes');
    charted.factory.executor.report('R2', { type: 'resultReported', summary: 'GitHub needs read:user only.', status: 'done', notes: '' });
    charted.factory.executor.report('R2', { type: 'runCompleted' });
    return { ...charted, tip };
  }

  test('touching only docs/research/**, has its branch pushed at L1 and its ticket closed, pointing at the branch', async () => {
    const { factory, tui, tip } = await researched(['docs/research/oauth-scopes.md']);

    await tui.until(() => !factory.github.issueState(TICKET).open);
    expect(factory.git.originTip(clone, 'research/oauth-scopes')).toBe(tip);
    expect(factory.github.pushes).toMatchObject([{ branch: 'research/oauth-scopes', token: { permissions: { contents: 'write' } } }]);
    const { comments, stateReason } = factory.github.issueState(TICKET);
    expect(stateReason).toBe('completed');
    expect(comments[0]).toContain('https://github.com/acme/widgets/tree/research/oauth-scopes');
    expect(comments[0]).toContain('GitHub needs read:user only.');
    // Its worktree and local branch go once the findings are on GitHub.
    await tui.until((state) => state.tasks.T2?.transcripts !== null);
    expect(factory.git.branchTip(clone, 'research/oauth-scopes')).toBeNull();
    expect(tui.state().attentionQueue.filter((item) => 'attention' in item)).toEqual([]);
  });

  test('touching any other path, isn’t pushed: an attention request names the paths, and the ticket stays open', async () => {
    const { factory, tui } = await researched(['docs/research/oauth-scopes.md', 'src/sign-in.ts']);

    const asked = await tui.until((state) => state.attentionQueue.some((item) => 'attention' in item));
    expect(asked.attentionQueue.find((item) => 'attention' in item)).toMatchObject({
      taskId: 'T2',
      attention: 'github-write',
      reason: expect.stringContaining('src/sign-in.ts'),
    });
    expect(factory.git.originTip(clone, 'research/oauth-scopes')).toBeNull();
    expect(factory.github.pushes).toEqual([]);
    expect(factory.github.issueState(TICKET).open).toBe(true);
    expect(asked.tasks.T2!.label).toBe('Done');
  });

  test('with no findings committed, has its ticket closed with its report, and nothing pushed', async () => {
    const { factory, tui } = await researched([]);

    await tui.until(() => !factory.github.issueState(TICKET).open);
    expect(factory.github.pushes).toEqual([]);
    expect(factory.github.issueState(TICKET).comments[0]).toContain('GitHub needs read:user only.');
  });

  test('a failed GitHub write raises a request, and answering it tries again, never as the operator', async () => {
    const charted = await charting();
    await spawnResearch(charted.factory, 'R1');
    const state = await charted.tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    const { factory, operator, tui } = charted;
    factory.git.editFile(state.tasks.T2!.worktree!, 'docs/research/oauth-scopes.md');
    factory.git.commitAll(state.tasks.T2!.worktree!);
    factory.github.uninstall('acme/widgets');
    factory.executor.report('R2', { type: 'runCompleted' });

    const asked = await tui.until((state) => state.attentionQueue.some((item) => 'attention' in item));
    expect(asked.attentionQueue.find((item) => 'attention' in item)).toMatchObject({
      taskId: 'T2',
      attention: 'github-write',
      reason: expect.stringContaining('isn’t installed on acme/widgets'),
    });
    expect(factory.github.issueState(TICKET).open).toBe(true);
    factory.github.install('acme/widgets');
    expect(await operator.send({ type: 'answer', taskId: 'T2' })).toEqual({ ok: true });

    await tui.until(() => !factory.github.issueState(TICKET).open);
    expect(factory.github.pushes).toHaveLength(1);
    expect(tui.state().attentionQueue.filter((item) => 'attention' in item)).toEqual([]);
  });

  test('cancelled, leaves its ticket open and pushes nothing', async () => {
    const { factory, operator, tui } = await charting();
    await spawnResearch(factory, 'R1');
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');

    await operator.send({ type: 'cancel', taskId: 'T2', branch: 'discard' });

    await tui.until((state) => state.tasks.T2?.transcripts !== null);
    expect(factory.github.pushes).toEqual([]);
    expect(factory.github.issueState(TICKET).open).toBe(true);
  });
});
