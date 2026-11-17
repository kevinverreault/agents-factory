// Seam 1: bring-out at advance and handoff (ADR 0015), through the client
// protocol. A contained HITL stage's commits stay in its task's container
// until the operator advances or hands off: then they come out to the host
// task branch as a fast-forward, checked by the git guards, under an
// intent. The sheets block rather than lose or force-move anything: on a
// dirty tree in the container, a broken guard, or a branch changed on both
// sides, where they offer to ask the agent to merge the host branch.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { relayHook } from '../hooks/relay.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import { FAKE_OPERATOR_EMAIL } from '../testing/fake-git.ts';
import { recoveryReport } from '../testing/recovery-report.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];
const clone = resolve('/clones/widgets');

// A preset whose grill and spec are contained, whose notes stage is not,
// and whose implement stage is AFK.
const PLANNING = [
  'stages:',
  '  - { id: grill, kind: run, skill: grill-me, args: "{{prompt}}", mode: HITL, contained: true }',
  '  - { id: spec, kind: run, skill: to-spec, mode: HITL, contained: true }',
  '  - { id: notes, kind: run, skill: notes, mode: HITL }',
  '  - { id: implement, kind: run, skill: implement, args: "{{prompt}}", mode: AFK }',
].join('\n');

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

async function attached(): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'oauth-token');
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(join(factory.paths.presetsDir, 'planning.preset.yaml'), PLANNING);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

// Resolves once every change sent before it has gone through the daemon.
async function settled(connection: FactoryConnection): Promise<void> {
  await connection.send({ type: 'daemon.status' });
}

const minutes = (n: number) => n * 60_000;

// A task at its contained grill, on the operator's turn, whose container
// holds a commit the host task branch lacks.
async function grilled(stage?: string): Promise<Factory & { branch: string; head: string; tip: string; workdir: string }> {
  const attachedFactory = await attached();
  const { factory, operator } = attachedFactory;
  await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'planning', prompt: 'Grill me about the login flow.', ...(stage && { stage }) });
  await started(factory, 1);
  const [worktree] = await factory.git.worktrees(clone);
  const workdir = factory.sandbox.workdirOf('T1');
  factory.git.editFile(workdir, 'GLOSSARY.md', 'Session: a signed-in visit.');
  factory.git.commitAll(workdir, { author: FAKE_OPERATOR_EMAIL });
  const tip = factory.git.branchTip(factory.sandbox.clonePathOf('T1'), worktree!.branch)!;
  factory.executor.report('R1', { type: 'turnEnded' });
  await settled(operator);
  return { ...attachedFactory, branch: worktree!.branch, head: worktree!.head, tip, workdir };
}

describe('advancing from a contained stage', () => {
  test('brings the container’s commits out to the host task branch, checked by the git guards, and the next contained stage starts on them', async () => {
    const { factory, operator, tui, branch, tip, workdir } = await grilled();

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });

    expect(factory.git.branchTip(clone, branch)).toBe(tip);
    expect(factory.git.checked).toEqual([{ worktreePath: workdir, branches: [], committer: FAKE_OPERATOR_EMAIL }]);
    expect(await started(factory, 2)).toMatchObject({ runId: 'R2', container: { taskId: 'T1' }, guards: { start: tip } });
    const state = await tui.until((state) => state.runs.R2?.status === 'active');
    expect(state.runs.R2).toMatchObject({ stage: 'spec', contained: true });
    expect(state.runs.R1).toMatchObject({ outcome: 'completed' });
  });

  test('is blocked while the container’s tree has uncommitted changes or untracked files, and nothing moves', async () => {
    const { factory, operator, tui, branch, head, workdir } = await grilled();
    factory.git.editFile(workdir, 'notes/draft.md', 'half a thought');

    const reply = await operator.send({ type: 'advanceStage', taskId: 'T1' });

    expect(reply).toEqual({
      ok: false,
      reason: 'The advance is blocked. T1’s container has changes not committed, which never come out of it: notes/draft.md. Ask the agent to commit or discard them first.',
    });
    expect(factory.git.branchTip(clone, branch)).toBe(head);
    expect(factory.sandbox.calls).not.toContain('bringOut T1');
    expect(tui.state().tasks.T1).toMatchObject({ stage: 'grill' });
  });

  test('is blocked, showing the violation, when the work in the container broke the git guards', async () => {
    const { factory, operator, tui, branch, head, workdir } = await grilled();
    factory.git.breakInvariant(workdir, 'The run changed git hooks: pre-commit.');

    const reply = await operator.send({ type: 'advanceStage', taskId: 'T1' });

    expect(reply).toEqual({ ok: false, reason: 'The advance is blocked. T1’s work in its container broke the factory’s git guards, so it stays there. The run changed git hooks: pre-commit.' });
    expect(factory.git.branchTip(clone, branch)).toBe(head);
    expect(tui.state().tasks.T1).toMatchObject({ stage: 'grill' });
  });

  test('is blocked while the agent is mid-turn, as it may commit more', async () => {
    const { factory, operator, branch, head } = await grilled();
    await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'One more thing.' });

    const reply = await operator.send({ type: 'advanceStage', taskId: 'T1' });

    expect(reply).toMatchObject({ ok: false, reason: expect.stringContaining('T1’s agent is mid-turn in its container') });
    expect(factory.git.branchTip(clone, branch)).toBe(head);
  });

  test('on a branch the container and the host both changed is blocked, offering to ask the agent to merge the host branch, which a factory note does', async () => {
    const { factory, operator, tui, branch, tip, workdir } = await grilled();
    const [worktree] = await factory.git.worktrees(clone);
    factory.git.editFile(worktree!.path, 'README.md', 'from the editor');
    factory.git.commitAll(worktree!.path, { author: FAKE_OPERATOR_EMAIL });
    const hostTip = factory.git.branchTip(clone, branch)!;

    const reply = await operator.send({ type: 'advanceStage', taskId: 'T1' });

    expect(reply).toEqual({
      ok: false,
      reason: `The advance is blocked. ${branch} has commits in T1’s container and on the host that the other lacks, so neither can take the other’s. Ask the agent to merge the host branch in first.`,
      confirm: { type: 'askToMergeHost', taskId: 'T1' },
    });
    // Nothing is force-moved, on either side.
    expect(factory.git.branchTip(clone, branch)).toBe(hostTip);
    expect(factory.git.branchTip(factory.sandbox.clonePathOf('T1'), branch)).toBe(tip);

    expect(await operator.send({ type: 'askToMergeHost', taskId: 'T1' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(factory.executor.sent.map(({ runId }) => runId)).toEqual(['R1']));
    const [note] = factory.executor.sent;
    expect(note!.text).toMatch(/^## Factory note\n\nThe operator’s task branch /);
    expect(note!.text).toContain(`\`git fetch origin ${branch}\`, then \`git merge origin/${branch}\``);

    // The agent merges, and the advance goes through.
    factory.executor.report('R1', { type: 'turnEnded' });
    await factory.git.merge(workdir, hostTip, 'Merge the host branch');
    await settled(operator);
    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });
    expect(factory.git.inHistory(hostTip, factory.git.branchTip(clone, branch)!)).toBe(true);
    expect(factory.git.branchTip(clone, branch)).toBe(factory.git.branchTip(factory.sandbox.clonePathOf('T1'), branch));
  });

  test('parked on a branch both sides changed, the agent asked to merge hears it as the reopened run starts, in its container', async () => {
    const { factory, operator, tui, branch, tip } = await grilled();
    factory.clock.advance(minutes(31));
    await tui.until((state) => state.tasks.T1?.label === 'Ready for you');
    const [worktree] = await factory.git.worktrees(clone);
    factory.git.editFile(worktree!.path, 'README.md', 'from the editor');
    factory.git.commitAll(worktree!.path, { author: FAKE_OPERATOR_EMAIL });

    const reply = await operator.send({ type: 'advanceStage', taskId: 'T1' });
    expect(reply).toMatchObject({ ok: false, confirm: { type: 'askToMergeHost', taskId: 'T1' } });
    expect(await operator.send({ type: 'askToMergeHost', taskId: 'T1' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(factory.sandbox.state('T1')).toBe('stopped'));

    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({ ok: true });

    const reopened = await started(factory, 2);
    expect(reopened).toMatchObject({ runId: 'R2', resumesSession: true, container: { taskId: 'T1' } });
    expect(reopened.firstMessage).toContain(`\`git merge origin/${branch}\``);
    expect(factory.sandbox.prepared.at(-1)).toMatchObject({ mergesHost: true });
    expect(factory.git.branchTip(factory.sandbox.clonePathOf('T1'), branch)).toBe(tip);
  });
});

// A preset whose contained grill hands off to a spec's tickets.
const TICKETED = [
  'stages:',
  '  - { id: grill, kind: run, skill: grill-me, args: "{{prompt}}", mode: HITL, contained: true }',
  '  - { id: implement, kind: tickets, skill: implement, mode: AFK, exit: spec-closed }',
].join('\n');

// Opens the handoff sheet, has R1 write the brief and end its turn, and
// gives the sheet as it then is.
async function briefed({ operator, tui, factory }: Factory): Promise<FactoryState> {
  expect(await operator.send({ type: 'openHandoff', taskId: 'T1' })).toEqual({ ok: true });
  await tui.until((state) => state.tasks.T1?.handoff != null);
  factory.executor.report('R1', { type: 'briefWritten', brief: { goal: 'Carry the work on.', decided: [], doneWhen: [], outOfScope: [], links: [] } });
  factory.executor.report('R1', { type: 'turnEnded' });
  await settled(operator);
  return tui.until((state) => !!state.tasks.T1?.handoff?.brief);
}

// Confirms the sheet as it was pre-filled, but for `changes`.
function confirmed(sheet: FactoryState, changes: { autonomy?: 'L1' | 'L2' | 'L3'; specs?: string[] } = {}) {
  const { brief, continueAs, autonomy, tier, maxTurns } = sheet.tasks.T1!.handoff!;
  return { type: 'handoff', taskId: 'T1', brief: brief!, continueAs, autonomy, tier, maxTurns, ...changes } as const;
}

describe('handing off from a contained stage', () => {
  test('to L1 brings the container’s commits out to the host task branch, checked, then stops the container, and the AFK run starts on the host from them', async () => {
    const grill = await grilled();
    const { factory, operator, tui, branch, tip, workdir } = grill;
    const sheet = await briefed(grill);
    expect(sheet.tasks.T1?.handoff?.readiness).toEqual({ blockers: [], toCommit: [] });

    expect(await operator.send(confirmed(sheet, { autonomy: 'L1' }))).toEqual({ ok: true });

    expect(factory.git.branchTip(clone, branch)).toBe(tip);
    expect(factory.git.checked[0]).toEqual({ worktreePath: workdir, branches: [], committer: FAKE_OPERATOR_EMAIL });
    expect(await started(factory, 2)).toMatchObject({ runId: 'R2', mode: 'AFK', autonomy: 'L1', container: null, guards: { start: tip } });
    await vi.waitFor(() => expect(factory.sandbox.state('T1')).toBe('stopped'));
    expect((await tui.until((state) => state.runs.R2?.status === 'active')).runs.R1).toMatchObject({ outcome: 'handed off' });
  });

  test('to L2 reuses the container with no bring-out: the AFK run starts there on the stage’s commits', async () => {
    const grill = await grilled();
    const { factory, operator, branch, head, tip } = grill;
    const sheet = await briefed(grill);
    factory.sandbox.calls.length = 0;

    expect(await operator.send(confirmed(sheet, { autonomy: 'L2' }))).toEqual({ ok: true });

    expect(await started(factory, 2)).toMatchObject({ runId: 'R2', mode: 'AFK', autonomy: 'L2', container: { taskId: 'T1' }, guards: { start: tip } });
    expect(factory.sandbox.calls).not.toContain('bringOut T1');
    expect(factory.git.branchTip(clone, branch)).toBe(head);
  });

  test('shows on its sheet, and is blocked by, uncommitted changes in the container', async () => {
    const grill = await grilled();
    const { factory, operator, branch, head, workdir } = grill;
    factory.git.editFile(workdir, 'notes/draft.md', 'half a thought');
    const sheet = await briefed(grill);
    const blocker = 'T1’s container has changes not committed, which never come out of it: notes/draft.md. Ask the agent to commit or discard them first.';
    expect(sheet.tasks.T1?.handoff?.readiness).toEqual({ blockers: [blocker], toCommit: [] });

    expect(await operator.send(confirmed(sheet, { autonomy: 'L1' }))).toEqual({ ok: false, reason: `The handoff is blocked. ${blocker}` });
    expect(factory.git.branchTip(clone, branch)).toBe(head);
    expect(factory.executor.started).toHaveLength(1);
  });

  test('shows on its sheet, and is blocked by, work in the container that broke the git guards', async () => {
    const grill = await grilled();
    const { factory, operator, branch, head, workdir } = grill;
    factory.git.breakInvariant(workdir, 'The run added remotes: elsewhere.');
    const sheet = await briefed(grill);
    const blocker = 'T1’s work in its container broke the factory’s git guards, so it stays there. The run added remotes: elsewhere.';
    expect(sheet.tasks.T1?.handoff?.readiness).toEqual({ blockers: [blocker], toCommit: [] });

    expect(await operator.send(confirmed(sheet, { autonomy: 'L1' }))).toEqual({ ok: false, reason: `The handoff is blocked. ${blocker}` });
    expect(factory.git.branchTip(clone, branch)).toBe(head);
  });

  test('on a branch both sides changed is blocked, its sheet offering to ask the agent to merge the host branch', async () => {
    const grill = await grilled();
    const { factory, operator, branch } = grill;
    const [worktree] = await factory.git.worktrees(clone);
    factory.git.editFile(worktree!.path, 'README.md', 'from the editor');
    factory.git.commitAll(worktree!.path, { author: FAKE_OPERATOR_EMAIL });
    const hostTip = factory.git.branchTip(clone, branch)!;

    const sheet = await briefed(grill);

    expect(sheet.tasks.T1?.handoff?.readiness).toMatchObject({ mergesHost: true, blockers: [expect.stringContaining('Ask the agent to merge the host branch in first.')] });
    expect(await operator.send(confirmed(sheet, { autonomy: 'L2' }))).toMatchObject({ ok: false });
    expect(factory.git.branchTip(clone, branch)).toBe(hostTip);
    expect(await operator.send({ type: 'askToMergeHost', taskId: 'T1' })).toEqual({ ok: true });
  });

  test('to a spec’s tickets brings the stage’s commits out first, so its ticket tasks are cut from them', async () => {
    const grill = await attached();
    const { factory, operator, tui } = grill;
    writeFileSync(join(factory.paths.presetsDir, 'ticketed.preset.yaml'), TICKETED);
    factory.github.addIssue('acme/widgets#20', { title: 'Sign-in' });
    factory.github.addIssue('acme/widgets#21', { title: 'A login form', parent: 'acme/widgets#20', labels: ['ready-for-agent'] });
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'ticketed', prompt: 'Grill me about sign-in.' });
    const run = await started(factory, 1);
    const [worktree] = await factory.git.worktrees(clone);
    const workdir = factory.sandbox.workdirOf('T1');
    factory.git.editFile(workdir, 'docs/adr/0001-sessions.md', 'Sessions last a day.');
    factory.git.commitAll(workdir, { author: FAKE_OPERATOR_EMAIL });
    const tip = factory.git.branchTip(factory.sandbox.clonePathOf('T1'), worktree!.branch)!;
    // The grill writes the spec, which artifact capture records.
    const event = { session_id: run.sessionId, cwd: run.cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh issue create' } };
    await relayHook(JSON.stringify({ ...event, tool_response: 'https://github.com/acme/widgets/issues/20\n' }), factory.paths);
    await tui.until((state) => Object.keys(state.artifacts).length > 0);
    factory.executor.report('R1', { type: 'turnEnded' });
    await settled(operator);
    const sheet = await briefed(grill);
    expect(sheet.tasks.T1?.handoff?.ticketSets?.selected).toBe('acme/widgets#20');

    expect(await operator.send(confirmed(sheet, { autonomy: 'L2', specs: ['acme/widgets#20'] }))).toEqual({ ok: true });

    expect(factory.git.branchTip(clone, worktree!.branch)).toBe(tip);
    const state = await tui.until((state) => !!state.tasks.T2?.worktree);
    expect(state.tasks.T2).toMatchObject({ kind: 'ticket', ticket: 'acme/widgets#21', specTask: 'T1' });
    const ticketWorktree = (await factory.git.worktrees(clone)).find(({ path }) => path === state.tasks.T2!.worktree)!;
    expect(factory.git.inHistory(tip, ticketWorktree.head)).toBe(true);
  });
});

async function crashAndRestart(factory: TestFactory, crashed: Promise<void>): Promise<Watched> {
  await crashed;
  await factory.crash();
  await factory.startDaemon();
  return watch(await factory.attach());
}

describe('a bring-out cut short by a crash', () => {
  test.each(['before', 'after'] as const)('at an advance, %s its bring-out, is finished by recovery through its intent, once the dead daemon’s run is parked', async (when) => {
    const { factory, operator, branch, tip } = await grilled();
    const crashed = factory.crashAt('sandbox', 'bringOut', when);
    void operator.send({ type: 'advanceStage', taskId: 'T1' });

    const tui = await crashAndRestart(factory, crashed);

    const state = await tui.until((state) => !!recoveryReport(state));
    expect(factory.git.branchTip(clone, branch)).toBe(tip);
    expect(state.tasks.T1).toMatchObject({ stage: 'spec' });
    // The dead daemon's run was parked, and the next stage started after it.
    expect(state.runs.R1).toMatchObject({ outcome: 'parked' });
    expect((await tui.until((state) => state.runs.R2?.status === 'active')).runs.R2).toMatchObject({ stage: 'spec', contained: true });
    expect(recoveryReport(state)!.recovery?.replayed).toEqual([{ taskId: 'T1', verb: 'advance', outcome: 'finished' }]);
  });

  test('at an advance whose work can no longer come out is rolled back: the task stays at its stage', async () => {
    const { factory, operator, branch, head, workdir } = await grilled();
    const crashed = factory.crashAt('sandbox', 'bringOut', 'before');
    void operator.send({ type: 'advanceStage', taskId: 'T1' });
    await crashed;
    await factory.crash();
    // The dead daemon's turn leaves a change in the container uncommitted.
    factory.git.editFile(workdir, 'notes/draft.md', 'half a thought');
    await factory.startDaemon();
    const tui = watch(await factory.attach());

    const state = await tui.until((state) => !!recoveryReport(state));
    expect(factory.git.branchTip(clone, branch)).toBe(head);
    expect(state.tasks.T1).toMatchObject({ stage: 'grill' });
    expect(recoveryReport(state)!.recovery?.replayed).toEqual([{ taskId: 'T1', verb: 'advance', outcome: 'rolled back' }]);
  });

  test('at a handoff, after its bring-out, is finished by recovery through the handoff’s intent', async () => {
    const grill = await grilled();
    const { factory, operator, branch, tip } = grill;
    const sheet = await briefed(grill);
    const crashed = factory.crashAt('sandbox', 'bringOut', 'after');
    void operator.send(confirmed(sheet, { autonomy: 'L1' }));

    const tui = await crashAndRestart(factory, crashed);

    const state = await tui.until((state) => !!recoveryReport(state));
    expect(factory.git.branchTip(clone, branch)).toBe(tip);
    expect(state.tasks.T1).toMatchObject({ mode: 'AFK', autonomy: 'L1' });
    expect(recoveryReport(state)!.recovery?.replayed).toEqual([{ taskId: 'T1', verb: 'handoff', outcome: 'finished' }]);
  });
});
