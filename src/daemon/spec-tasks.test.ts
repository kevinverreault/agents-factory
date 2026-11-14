// Seam 1: spec tasks (ADR 0013), through the client protocol. Launching
// `implement` at a `tickets` stage on a spec ref (an issue with sub-issues),
// or on several refs, makes a spec task: it runs no agent and holds no slot,
// reads its ticket set from GitHub and launches one ticket task per
// frontier ticket, in sub-issue order: AFK for `ready-for-agent`, HITL for
// `ready-for-human`, any other label held back. Each
// ticket task runs the spec task's frozen stages from the `tickets` stage
// on, inherits its handoff fields, and is cut from its branch merged with
// the latest `origin/<base>`.
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { recoveryReport } from '../testing/recovery-report.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const READY = ['ready-for-agent'];
const SPEC = 'acme/widgets#10';
const clone = resolve('/clones/widgets');

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

// A factory with a subscription token for L2 runs, and the spec #10 on GitHub with its
// sub-issues: #11 ready, #12 ready but blocked by #11, #13 untriaged, #14
// ready but closed, and #15 ready.
async function attached(): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  const { github } = factory;
  github.addIssue(SPEC, { title: 'Sign-in' });
  github.addIssue('acme/widgets#11', { title: 'A login form', parent: SPEC, labels: READY });
  github.addIssue('acme/widgets#12', { title: 'Remember me', parent: SPEC, labels: READY, blockedBy: ['acme/widgets#11'] });
  github.addIssue('acme/widgets#13', { title: 'SSO', parent: SPEC });
  github.addIssue('acme/widgets#14', { title: 'The sign-in route', parent: SPEC, labels: READY });
  github.close('acme/widgets#14');
  github.addIssue('acme/widgets#15', { title: 'Sign out', parent: SPEC, labels: READY });
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

// `implement` launched on the spec ref.
const onSpec = (extra: Partial<LaunchCommand> = {}): LaunchCommand => ({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', issues: ['#10'], ...extra });

// The ticket tasks, by their ticket.
const ticketTasks = (state: FactoryState) =>
  Object.fromEntries(Object.values(state.tasks).flatMap((task) => (task.kind === 'ticket' && task.ticket ? [[task.ticket, task.id]] : [])));

// The run that started `n`th, once the executor has it.
async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

describe('launching implement on a spec ref', () => {
  test('makes a spec task, holding no slot and running nothing, and a ticket task per open, unblocked ready-for-agent ticket in sub-issue order', async () => {
    const { factory, operator, tui } = await attached();

    expect(await operator.send(onSpec())).toEqual({ ok: true, value: { taskId: 'T1' } });

    const state = await tui.until((state) => !!state.tasks.T3?.liveRunId && !!state.tasks.T2?.liveRunId);
    expect(state.tasks.T1).toMatchObject({ kind: 'spec', ticket: null, specTask: null, mergePolicy: 'operator', mode: 'AFK', liveRunId: null, stage: 'implement' });
    expect(state.tasks.T1?.ticketSet?.tickets.map(({ ref }) => ref)).toEqual(['acme/widgets#11', 'acme/widgets#12', 'acme/widgets#13', 'acme/widgets#14', 'acme/widgets#15']);
    expect(ticketTasks(state)).toEqual({ 'acme/widgets#11': 'T2', 'acme/widgets#15': 'T3' });
    expect(state.tasks.T2).toMatchObject({ kind: 'ticket', ticket: 'acme/widgets#11', specTask: 'T1', mergePolicy: 'operator', mode: 'AFK', stage: 'implement', title: 'A login form' });
    expect(state.tasks.T3).toMatchObject({ kind: 'ticket', ticket: 'acme/widgets#15', specTask: 'T1', title: 'Sign out' });
    expect(Object.values(state.runs).map(({ taskId }) => taskId)).toEqual(['T2', 'T3']);
    expect(factory.executor.started.map(({ firstMessage }) => firstMessage?.split('\n')[0])).toEqual([
      '/factory:implement acme/widgets#11',
      '/factory:implement acme/widgets#15',
    ]);
    // Only reads: the factory writes nothing on GitHub to launch them.
    expect(factory.github.writes).toEqual([]);
  });
});

describe('the spec task’s ticket set', () => {
  test('shows each ticket with its state: launched with its ticket task, waiting on its blockers, held back by its label, or merged', async () => {
    const { operator, tui } = await attached();

    await operator.send(onSpec());

    const state = await tui.until((state) => !!state.tasks.T3?.liveRunId && !!state.tasks.T2?.liveRunId);
    expect(state.tasks.T1?.ticketSet).toEqual({
      spec: SPEC,
      tickets: [
        { ref: 'acme/widgets#11', title: 'A login form', state: 'launched', taskId: 'T2' },
        { ref: 'acme/widgets#12', title: 'Remember me', state: 'waiting', blockers: ['acme/widgets#11'] },
        { ref: 'acme/widgets#13', title: 'SSO', state: 'held-back' },
        { ref: 'acme/widgets#14', title: 'The sign-in route', state: 'merged', taskId: null },
        { ref: 'acme/widgets#15', title: 'Sign out', state: 'launched', taskId: 'T3' },
      ],
      problem: null,
    });
  });
  test('a ticket labelled for neither an agent nor the operator is held back, blocked or not', async () => {
    const { factory, operator, tui } = await attached();
    factory.github.addIssue('acme/widgets#16', { title: 'Audit log', parent: SPEC, blockedBy: ['acme/widgets#11'] });

    await operator.send(onSpec());

    const state = await tui.until((state) => !!state.tasks.T3?.liveRunId && !!state.tasks.T2?.liveRunId);
    expect(state.tasks.T1?.ticketSet?.tickets.at(-1)).toEqual({ ref: 'acme/widgets#16', title: 'Audit log', state: 'held-back' });
  });
});

describe('ticket labels', () => {
  test('a frontier ready-for-human ticket gets a HITL ticket task, Ready for you and holding no slot, whose opening starts its first session on its skill with the same context', async () => {
    const { factory, operator, tui } = await attached();
    factory.github.addIssue('acme/widgets#16', { title: 'Brand the login', parent: SPEC, labels: ['ready-for-human'] });
    await operator.send({ type: 'setSlotCap', cap: 2 });

    await operator.send(onSpec());

    let state = await tui.until((state) => Object.keys(ticketTasks(state)).length === 3 && !!state.tasks.T2?.liveRunId && !!state.tasks.T3?.liveRunId);
    expect(ticketTasks(state)).toEqual({ 'acme/widgets#11': 'T2', 'acme/widgets#15': 'T3', 'acme/widgets#16': 'T4' });
    expect(state.tasks.T4).toMatchObject({ kind: 'ticket', ticket: 'acme/widgets#16', specTask: 'T1', mode: 'HITL', label: 'Ready for you', liveRunId: null });
    expect(state.slots).toEqual({ active: 2, cap: 2 });
    expect(state.tasks.T1?.ticketSet?.tickets.find(({ ref }) => ref === 'acme/widgets#16')).toEqual({ ref: 'acme/widgets#16', title: 'Brand the login', state: 'launched', taskId: 'T4' });

    expect(await operator.send({ type: 'open', taskId: 'T4' })).toEqual({ ok: true });

    state = await tui.until((state) => !!state.tasks.T4?.liveRunId);
    const run = factory.executor.started.find(({ runId }) => runId === state.tasks.T4!.liveRunId)!;
    expect(run.mode).toBe('HITL');
    const [first, ...rest] = run.firstMessage!.split('\n');
    expect(first).toBe('/factory:implement acme/widgets#16');
    const afk = factory.executor.started[0]!.firstMessage!;
    expect(rest.join('\n')).toContain('This task, T4, is a ticket task of the spec task T1');
    expect(rest.join('\n')).toContain('- Spec: acme/widgets#10');
    expect(afk).toContain('acme/widgets#16, Brand the login: in flight');
  });

  test('a HITL ticket task is handed off by the usual rules, at its spec task’s level, and ends in its own review and PR closing its ticket', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    factory.github.addIssue('acme/widgets#16', { title: 'Brand the login', parent: SPEC, labels: ['ready-for-human'] });
    await operator.send(onSpec({ autonomy: 'L2' }));
    await tui.until((state) => state.tasks.T4?.label === 'Ready for you');
    await operator.send({ type: 'open', taskId: 'T4' });
    const conversation = (await tui.until((state) => !!state.tasks.T4?.liveRunId)).tasks.T4!.liveRunId!;
    factory.executor.report(conversation, { type: 'turnEnded' });

    await operator.send({ type: 'openHandoff', taskId: 'T4' });
    const brief = { goal: 'Brand the login form.', decided: ['Use the brand blue.'], doneWhen: [], outOfScope: [], links: [] };
    factory.executor.report(conversation, { type: 'briefWritten', brief });
    factory.executor.report(conversation, { type: 'turnEnded' });
    const sheet = (await tui.until((state) => !!state.tasks.T4?.handoff?.brief && state.runs[conversation]?.turn === 'operator')).tasks.T4!.handoff!;
    expect(sheet).toMatchObject({ stage: 'implement', autonomy: 'L2', ticketSets: null });
    const { continueAs, autonomy, tier, maxTurns } = sheet;
    expect(await operator.send({ type: 'handoff', taskId: 'T4', brief, continueAs, autonomy, tier, maxTurns })).toEqual({ ok: true });

    const pr = await toReview(launched, 'T4');

    const state = tui.state();
    expect(state.tasks.T4).toMatchObject({ kind: 'ticket', mode: 'AFK', label: 'In review' });
    expect(factory.github.pullRequests.find(({ number }) => number === pr)?.body).toMatch(/^Closes #16$/m);
  });
});

// The open attention requests, leaving out the PRs in review.
const requests = (state: FactoryState) => state.attentionQueue.filter(({ kind }) => kind === 'attention');

describe('only held-back tickets left', () => {
  test('once nothing is in flight, the spec task raises stage-blocked naming them; answering re-reads the set, launching a ticket relabelled ready-for-agent meanwhile', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    factory.github.close('acme/widgets#12');
    factory.github.close('acme/widgets#15');
    factory.github.addIssue('acme/widgets#16', { title: 'Audit log', parent: SPEC, labels: ['needs-info'] });
    await operator.send(onSpec({ autonomy: 'L2' }));
    await tui.until((state) => !!state.tasks.T2?.liveRunId);
    const pr = await toReview(launched, 'T2');
    expect(requests(tui.state())).toEqual([]);

    await merge(launched, pr);

    const blocked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(requests(blocked)).toMatchObject([
      {
        taskId: 'T1',
        attention: 'stage-blocked',
        reason:
          'implement has only held-back tickets left: acme/widgets#13 (no label) and acme/widgets#16 (needs-info). ' +
          'Label one ready-for-agent or ready-for-human on GitHub, then answer to read the tickets again.',
      },
    ]);
    expect(Object.keys(ticketTasks(blocked))).toEqual(['acme/widgets#11']);
    factory.github.relabel('acme/widgets#13', READY);

    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });

    const state = await tui.until((state) => !!state.tasks.T3?.liveRunId);
    expect(ticketTasks(state)).toEqual({ 'acme/widgets#11': 'T2', 'acme/widgets#13': 'T3' });
    expect(state.tasks.T1?.label).not.toBe('Needs you');
    expect(requests(state)).toEqual([]);
  });

  test('a spec task whose every open ticket is held back at its first read raises stage-blocked at once, launching nothing', async () => {
    const { factory, operator, tui } = await attached();

    await operator.send(onSpec({ issues: ['#13', '#14'] }));

    const blocked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(requests(blocked)).toMatchObject([{ taskId: 'T1', attention: 'stage-blocked' }]);
    expect(requests(blocked)[0]).toMatchObject({ reason: expect.stringContaining('only held-back tickets left: acme/widgets#13 (no label).') });
    expect(Object.keys(blocked.tasks)).toEqual(['T1']);
    expect(factory.executor.started).toEqual([]);
  });
});

describe('launching implement on several refs', () => {
  test('makes a spec task with no spec, each ref one of its tickets, in launch order', async () => {
    const { factory, operator, tui } = await attached();

    await operator.send(onSpec({ issues: ['#15', '#11', '#13'] }));

    const state = await tui.until((state) => !!state.tasks.T2?.liveRunId && !!state.tasks.T3?.liveRunId);
    expect(state.tasks.T1).toMatchObject({ kind: 'spec', liveRunId: null });
    expect(state.tasks.T1?.ticketSet?.spec).toBeNull();
    expect(state.tasks.T1?.ticketSet?.tickets.map(({ ref }) => ref)).toEqual(['acme/widgets#15', 'acme/widgets#11', 'acme/widgets#13']);
    expect(ticketTasks(state)).toEqual({ 'acme/widgets#15': 'T2', 'acme/widgets#11': 'T3' });
    expect(factory.executor.started[0]!.firstMessage).not.toContain('- Spec:');
  });
});

describe('ticket tasks and the slot cap', () => {
  test('with more frontier tickets than free slots, they start in frontier order as slots free up', async () => {
    const { factory, operator, tui } = await attached();
    factory.github.addIssue('acme/widgets#16', { title: 'Lock out', parent: SPEC, labels: READY });
    await operator.send({ type: 'setSlotCap', cap: 1 });

    await operator.send(onSpec());

    let state = await tui.until((state) => Object.keys(ticketTasks(state)).length === 3 && !!state.tasks.T2?.liveRunId);
    expect(ticketTasks(state)).toEqual({ 'acme/widgets#11': 'T2', 'acme/widgets#15': 'T3', 'acme/widgets#16': 'T4' });
    expect([state.tasks.T3?.label, state.tasks.T4?.label]).toEqual(['Queued', 'Queued']);

    // Its run failing, T2 waits on the operator and frees its slot.
    factory.executor.report('R1', { type: 'runFailed', reason: 'The tests don’t build.' });
    state = await tui.until((state) => !!state.tasks.T3?.liveRunId);
    expect(state.tasks.T4?.label).toBe('Queued');

    factory.executor.report('R2', { type: 'runFailed', reason: 'The tests don’t build.' });
    await tui.until((state) => !!state.tasks.T4?.liveRunId);
    expect(factory.executor.started.map(({ firstMessage }) => firstMessage?.split('\n')[0])).toEqual([
      '/factory:implement acme/widgets#11',
      '/factory:implement acme/widgets#15',
      '/factory:implement acme/widgets#16',
    ]);
  });
});

describe('a ticket task', () => {
  test('first opens on its stage’s skill and its ticket, then the spec, its sibling tickets with their state, and the operator’s prompt', async () => {
    const { factory, operator, tui } = await attached();

    await operator.send(onSpec({ prompt: 'Mind the accessibility.' }));

    const state = await tui.until((state) => !!state.tasks.T2?.liveRunId && !!state.tasks.T3?.liveRunId);
    const { branch } = state.tasks.T2!;
    expect((await started(factory, 1)).firstMessage).toBe(
      [
        '/factory:implement acme/widgets#11',
        '',
        '## Factory context',
        '',
        `This task, T2, is a ticket task of the spec task T1, ${state.tasks.T1!.title}. Work on acme/widgets#11 alone, on the task branch ${branch}: ` +
          'its PR closes acme/widgets#11 once merged. Sibling tickets are other tasks’ work: don’t start them.',
        '',
        '- Spec: acme/widgets#10',
        '- Sibling tickets:',
        '  - acme/widgets#12, Remember me: waiting on acme/widgets#11',
        '  - acme/widgets#13, SSO: waiting',
        '  - acme/widgets#14, The sign-in route: closed',
        '  - acme/widgets#15, Sign out: in flight',
        '',
        '## Operator instructions',
        'Mind the accessibility.',
      ].join('\n'),
    );
    // Launched after it, T3 sees T2 in flight on its ticket.
    expect((await started(factory, 2)).firstMessage).toContain('  - acme/widgets#11, A login form: in flight (T2, Running)');
  });

  test('inherits the spec task’s autonomy, tier, max turns, groups, priority and merge policy, and runs its frozen stages from the tickets stage on', async () => {
    const { factory, operator, tui } = await attached();

    await operator.send(onSpec({ autonomy: 'L2', tier: 'opus', maxTurns: 40, groups: ['sign-in'], priority: 'urgent' }));

    const state = await tui.until((state) => !!state.tasks.T2?.liveRunId);
    const spec = state.tasks.T1!;
    expect(state.tasks.T2).toMatchObject({ autonomy: 'L2', tier: 'opus', groups: ['sign-in'], priority: 'urgent', mergePolicy: 'operator', specTask: 'T1' });
    expect(state.tasks.T2?.preset).toMatchObject({ name: 'implement', source: 'built-in', hash: spec.preset!.hash, repoCommit: spec.preset!.repoCommit });
    expect(state.tasks.T2?.preset?.stages.map(({ id }) => id)).toEqual(['implement', 'review', 'pr-body', 'open-pr']);
    expect(state.runs.R1).toMatchObject({ taskId: 'T2', tier: 'opus', maxTurns: 40, autonomy: 'L2', stage: 'implement' });
    // At L2 it runs in its own container.
    expect(factory.sandbox.prepared.map(({ taskId }) => taskId)).toContain('T2');
  });

  test('is cut from the spec task’s branch merged with the latest origin/<base>, which its L2 container gets too; a ticket set GitHub couldn’t read is read again at the next poll', async () => {
    const { factory, operator, tui } = await attached();
    // #77 isn't on GitHub yet: the spec task can't read its tickets.
    await operator.send(onSpec({ issues: ['#11', '#77'], autonomy: 'L2' }));
    const unread = await tui.until((state) => !!state.tasks.T1?.ticketSet?.problem);
    expect(unread.tasks.T1?.ticketSet?.problem).toMatch(/^The factory couldn’t read T1’s tickets from GitHub: /);
    expect(Object.keys(unread.tasks)).toEqual(['T1']);
    // Meanwhile the spec task's branch holds the operator's docs, and main moves on.
    const specWorktree = unread.tasks.T1!.worktree!;
    factory.git.editFile(specWorktree, 'GLOSSARY.md', 'Ticket task.\n');
    factory.git.commitAll(specWorktree);
    const docs = factory.git.branchTip(clone, unread.tasks.T1!.branch!)!;
    const main = factory.git.advanceOrigin(clone, 'main', { 'src/app.ts': 'export {};\n' });
    factory.github.addIssue('acme/widgets#77', { title: 'Session expiry' });

    factory.clock.advance(15 * 60_000);
    await operator.send({ type: 'daemon.status' });

    const state = await tui.until((state) => !!state.tasks.T2?.liveRunId);
    expect(state.tasks.T1?.ticketSet?.problem).toBeNull();
    const tip = factory.git.branchTip(clone, state.tasks.T2!.branch!)!;
    expect(factory.git.inHistory(docs, tip)).toBe(true);
    expect(factory.git.inHistory(main, tip)).toBe(true);
    const [container] = await factory.git.worktrees(factory.sandbox.clonePathOf('T2'));
    expect(container!.head).toBe(tip);
    // The spec task's own branch is left as it was.
    expect(factory.git.branchTip(clone, state.tasks.T1!.branch!)).toBe(docs);
  });

  test('whose branch can’t be merged with origin/<base> isn’t launched: the spec task says why, and launches it at the next poll', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(onSpec({ issues: ['#11', '#77'] }));
    const unread = await tui.until((state) => !!state.tasks.T1?.ticketSet?.problem);
    const specWorktree = unread.tasks.T1!.worktree!;
    factory.git.editFile(specWorktree, 'README.md', 'Mine.\n');
    factory.git.commitAll(specWorktree);
    factory.git.advanceOrigin(clone, 'main', { 'README.md': 'Theirs.\n' });
    factory.github.addIssue('acme/widgets#77', { title: 'Session expiry' });
    factory.clock.advance(15 * 60_000);
    await operator.send({ type: 'daemon.status' });

    const conflicted = await tui.until((state) => !!state.tasks.T1?.ticketSet?.problem?.includes('acme/widgets#11'));
    expect(conflicted.tasks.T1?.ticketSet?.problem).toMatch(/^The factory couldn’t launch a ticket task on acme\/widgets#11: The factory couldn’t cut factory\/T2-a-login-form from /);
    expect(Object.keys(conflicted.tasks)).toEqual(['T1']);
    expect(factory.git.branchTip(clone, 'factory/T2-a-login-form')).toBeNull();
    expect(conflicted.tasks.T1?.ticketSet?.tickets.filter(({ state }) => state === 'launched')).toEqual([]);

    // The operator resolves it on the spec task's branch.
    factory.git.editFile(specWorktree, 'README.md', 'Theirs.\n');
    factory.git.commitAll(specWorktree);
    factory.clock.advance(15 * 60_000);
    await operator.send({ type: 'daemon.status' });

    const state = await tui.until((state) => !!state.tasks.T2?.liveRunId);
    expect(ticketTasks(state)).toEqual({ 'acme/widgets#11': 'T2' });
  });
});

describe('a crash while launching a ticket task', () => {
  // A spec task over #11 and #77, which GitHub has only once the crash
  // point is armed: the next poll reads them and launches #11's ticket task.
  async function crashingAt(factory: TestFactory, operator: FactoryConnection, tui: Watched, step: string, when: 'before' | 'after') {
    await operator.send(onSpec({ issues: ['#11', '#77'] }));
    await tui.until((state) => !!state.tasks.T1?.ticketSet?.problem);
    const crashed = factory.crashAt('git', step, when);
    factory.github.addIssue('acme/widgets#77', { title: 'Session expiry' });
    factory.clock.advance(15 * 60_000);
    void operator.send({ type: 'daemon.status' });
    await crashed;
    await factory.crash();
  }

  test.each([
    ['before', 'addWorktree'],
    ['after', 'addWorktree'],
    ['after', 'merge'],
  ] as const)('%s %s is finished on the next start, launching one ticket task on one branch', async (when, step) => {
    const { factory, operator, tui } = await attached();
    await crashingAt(factory, operator, tui, step, when);
    await factory.startDaemon();
    const restarted = watch(await factory.attach());

    const state = await restarted.until((state) => !!state.tasks.T2?.liveRunId);
    expect(Object.keys(state.tasks)).toEqual(['T1', 'T2']);
    expect(ticketTasks(state)).toEqual({ 'acme/widgets#11': 'T2' });
    expect((await factory.git.worktrees(clone)).filter(({ branch }) => branch.startsWith('factory/T2-'))).toHaveLength(1);
    expect(factory.executor.started.map(({ firstMessage }) => firstMessage?.split('\n')[0])).toEqual(['/factory:implement acme/widgets#11']);
    expect(recoveryReport(state)?.recovery?.replayed).toEqual([{ taskId: 'T1', verb: 'launch', outcome: 'finished' }]);
  });

  test('whose worktree can’t be cut on the next start is rolled back, touching nothing it didn’t cut', async () => {
    const { factory, operator, tui } = await attached();
    await crashingAt(factory, operator, tui, 'addWorktree', 'before');
    // Meanwhile something else took the ticket task's branch.
    const elsewhere = resolve('/elsewhere/T2');
    await factory.git.addWorktree(clone, { path: elsewhere, branch: 'factory/T2-a-login-form', startPoint: 'origin/main' });
    await factory.startDaemon();
    const restarted = watch(await factory.attach());

    const state = await restarted.until((state) => !!recoveryReport(state) && !!state.tasks.T1?.ticketSet?.problem?.includes('acme/widgets#11'));
    expect(recoveryReport(state)?.recovery?.replayed).toEqual([{ taskId: 'T1', verb: 'launch', outcome: 'rolled back' }]);
    expect(Object.keys(state.tasks)).toEqual(['T1']);
    expect((await factory.git.worktrees(clone)).filter(({ branch }) => branch === 'factory/T2-a-login-form')).toMatchObject([{ path: elsewhere }]);
    expect(state.tasks.T1?.ticketSet?.tickets.filter(({ state }) => state === 'launched')).toEqual([]);
  });
});

// Works the ticket task `taskId`'s runs at L2 through its PR body (its
// implementation commits), then waits for it In review with its PR, whose
// number it returns.
async function toReview({ factory, tui }: Factory, taskId: string): Promise<number> {
  let state = await tui.until((state) => !!state.tasks[taskId]?.liveRunId);
  let run = state.tasks[taskId]!.liveRunId!;
  const workdir = factory.sandbox.workdirOf(taskId);
  factory.git.editFile(workdir, `src/${taskId}.ts`);
  factory.git.commitAll(workdir);
  factory.executor.report(run, { type: 'runCompleted' });
  // The review finds nothing.
  state = await tui.until((state) => !!state.tasks[taskId]?.liveRunId && state.tasks[taskId].liveRunId !== run);
  run = state.tasks[taskId]!.liveRunId!;
  factory.executor.report(run, { type: 'runCompleted' });
  state = await tui.until((state) => !!state.tasks[taskId]?.liveRunId && state.tasks[taskId].liveRunId !== run);
  run = state.tasks[taskId]!.liveRunId!;
  factory.executor.report(run, { type: 'prBodyWritten', body: `The work of ${taskId}.` });
  factory.executor.report(run, { type: 'runCompleted' });
  state = await tui.until((state) => state.tasks[taskId]?.label === 'In review' && !!state.tasks[taskId].pr);
  return state.tasks[taskId]!.pr!.number;
}

// Someone merges the PR on GitHub, and a TUI attaching makes the daemon read it.
async function merge({ factory }: Factory, number: number): Promise<void> {
  factory.github.merge(number);
  watch(await factory.attach());
}

// The tickets the implement runs started on, in order.
const runTickets = (factory: TestFactory) =>
  factory.executor.started.flatMap(({ firstMessage }) => (firstMessage?.startsWith('/factory:implement ') ? [firstMessage.split('\n')[0]!.split(' ')[1]] : []));

describe('blockers clearing on merge', () => {
  test('a ticket whose blocker’s ticket task is at work or In review isn’t launched; it is once that PR merged and the blocker closed', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(onSpec({ autonomy: 'L2' }));
    await tui.until((state) => !!state.tasks.T2?.liveRunId && !!state.tasks.T3?.liveRunId);

    const pr = await toReview(launched, 'T2');
    expect(Object.keys(ticketTasks(tui.state()))).not.toContain('acme/widgets#12');

    await merge(launched, pr);

    const state = await tui.until((state) => !!ticketTasks(state)['acme/widgets#12']);
    expect(state.tasks.T2?.label).toBe('Done');
    expect(factory.github.issueState('acme/widgets#11').open).toBe(false);
    expect(ticketTasks(state)).toEqual({ 'acme/widgets#11': 'T2', 'acme/widgets#15': 'T3', 'acme/widgets#12': 'T4' });
    await tui.until((state) => !!state.tasks.T4?.liveRunId);
    expect(runTickets(factory).filter((ticket) => ticket === 'acme/widgets#12')).toHaveLength(1);
  });

  test('the spec task re-reads its sub-issues and blockers on GitHub: reordering and blocking edits there change the next launches, and no ticket launches twice', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(onSpec({ autonomy: 'L2' }));
    await tui.until((state) => !!state.tasks.T2?.liveRunId && !!state.tasks.T3?.liveRunId);
    const pr = await toReview(launched, 'T2');
    // Meanwhile on GitHub: two new tickets blocked by #11, put first, and #12 now blocked by #15 too.
    factory.github.addIssue('acme/widgets#16', { title: 'Lock out', parent: SPEC, labels: READY, blockedBy: ['acme/widgets#11'] });
    factory.github.addIssue('acme/widgets#17', { title: 'Password reset', parent: SPEC, labels: READY, blockedBy: ['acme/widgets#11'] });
    factory.github.reorder(SPEC, ['acme/widgets#17', 'acme/widgets#16', 'acme/widgets#11', 'acme/widgets#12', 'acme/widgets#13', 'acme/widgets#14', 'acme/widgets#15']);
    factory.github.block('acme/widgets#12', 'acme/widgets#15');

    await merge(launched, pr);

    const state = await tui.until((state) => Object.keys(ticketTasks(state)).length === 4 && !!state.tasks.T5?.liveRunId);
    expect(ticketTasks(state)).toEqual({ 'acme/widgets#11': 'T2', 'acme/widgets#15': 'T3', 'acme/widgets#17': 'T4', 'acme/widgets#16': 'T5' });
    expect(state.tasks.T1?.ticketSet?.tickets.map(({ ref }) => ref)).toEqual([
      'acme/widgets#17',
      'acme/widgets#16',
      'acme/widgets#11',
      'acme/widgets#12',
      'acme/widgets#13',
      'acme/widgets#14',
      'acme/widgets#15',
    ]);
    expect(state.tasks.T1?.ticketSet?.tickets.find(({ ref }) => ref === 'acme/widgets#12')).toMatchObject({ state: 'waiting', blockers: ['acme/widgets#15'] });
    expect(runTickets(factory)).toEqual(['acme/widgets#11', 'acme/widgets#15', 'acme/widgets#17', 'acme/widgets#16']);
  });
});

describe('the spec resolving', () => {
  // The spec #10 with #12 and #13 closed too: #11 and #15 are its open tickets.
  async function twoOpen(): Promise<Factory> {
    const launched = await attached();
    launched.factory.github.close('acme/widgets#12');
    launched.factory.github.close('acme/widgets#13');
    await launched.operator.send(onSpec({ autonomy: 'L2' }));
    await launched.tui.until((state) => !!state.tasks.T2?.liveRunId && !!state.tasks.T3?.liveRunId);
    return launched;
  }

  test('once no ticket is open, the factory closes the spec as its App, with a token for that write alone and a comment listing each ticket and its merged PR; the spec task is Done and cleaned up, its branch included', async () => {
    const launched = await twoOpen();
    const { factory, tui } = launched;
    const branch = tui.state().tasks.T1!.branch!;
    const first = await toReview(launched, 'T2');
    const second = await toReview(launched, 'T3');

    await merge(launched, first);
    await tui.until((state) => state.tasks.T2?.label === 'Done' && state.tasks.T2.resolving === null);
    expect(tui.state().tasks.T1?.label).not.toBe('Done');
    expect(factory.github.issueState(SPEC).open).toBe(true);

    await merge(launched, second);

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(factory.github.issueState(SPEC)).toMatchObject({ open: false, stateReason: 'completed' });
    const close = factory.github.writes.find(({ ref }) => ref === SPEC)!;
    expect(close).toMatchObject({ action: 'close', token: { repo: 'acme/widgets', permissions: { issues: 'write', metadata: 'read' } } });
    expect(factory.github.minted.filter(({ token }) => token === close.token.token)).toHaveLength(1);
    expect(close.comment).toContain(`acme/widgets#11, A login form: merged in https://github.com/acme/widgets/pull/${first}`);
    expect(close.comment).toContain(`acme/widgets#15, Sign out: merged in https://github.com/acme/widgets/pull/${second}`);
    expect(close.comment).toContain('acme/widgets#14, The sign-in route: closed');
    expect(done.tasks.T1?.ticketSet?.tickets.every(({ state }) => state === 'merged')).toBe(true);
    expect((await factory.git.worktrees(clone)).map(({ path }) => path)).not.toContain(done.tasks.T1!.worktree);
    expect(factory.git.branchTip(clone, branch)).toBeNull();
  });

  test('a spec task with no spec whose tickets were all closed with no ticket task merged is Done, keeping its branch as the only copy of its docs', async () => {
    const { factory, operator, tui } = await attached();
    factory.github.close('acme/widgets#12');

    await operator.send(onSpec({ issues: ['#12', '#14'] }));

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(Object.keys(done.tasks)).toEqual(['T1']);
    expect(factory.github.writes).toEqual([]);
    expect(factory.git.branchTip(clone, done.tasks.T1!.branch!)).not.toBeNull();
    expect((await factory.git.worktrees(clone)).map(({ path }) => path)).not.toContain(done.tasks.T1!.worktree);
  });

  test('a spec the factory couldn’t close is closed at the next poll', async () => {
    const launched = await twoOpen();
    const { factory, operator, tui } = launched;
    const first = await toReview(launched, 'T2');
    const second = await toReview(launched, 'T3');
    await merge(launched, first);
    await tui.until((state) => state.tasks.T2?.label === 'Done' && state.tasks.T2.resolving === null);
    factory.github.close('acme/widgets#15');
    factory.github.failIssueWrites('Service Unavailable.');

    await merge(launched, second);

    const failed = await tui.until((state) => !!state.tasks.T1?.ticketSet?.problem);
    expect(failed.tasks.T1?.ticketSet?.problem).toBe('The factory couldn’t close acme/widgets#10 on GitHub: Service Unavailable.');
    expect(failed.tasks.T1?.label).not.toBe('Done');
    factory.github.failIssueWrites(null);

    factory.clock.advance(15 * 60_000);
    await operator.send({ type: 'daemon.status' });

    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(factory.github.issueState(SPEC).open).toBe(false);
  });
});
