// Seam 1: the review stage and the PR body. A review stage with
// `on_findings: fix-once` that reports findings gets exactly one AFK fix
// pass, never a loop, and what that pass leaves over goes into the PR body.
// The PR body stage writes the body through the factory, which lists every
// ticket the task closed as `Implements #n` (ADR 0006). At L1 `open-pr` is
// skipped and the root goes In review, its task branch still only local
// (ADR 0007).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { handOff } from '../testing/handoff.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

// build → review (fix-once) → pr-body → open-pr, as main-flow ends.
const PRESET = `stages:
  - { id: build, kind: run, mode: AFK, skill: implement, args: "{{prompt}}", exit: run-completed }
  - { id: review, kind: run, mode: AFK, skill: code-review, on_findings: fix-once, exit: run-completed }
  - { id: pr-body, kind: run, mode: AFK, skill: pr, exit: "artifact:pr-body" }
  - { id: open-pr, kind: action, mode: AFK, requires: L2 }
`;

const question = {
  id: 'toolu_01',
  questions: [
    {
      question: 'Is the header the right place?',
      header: 'Place',
      options: [
        { label: 'Yes', description: 'Keep it in the header' },
        { label: 'No', description: 'Move it to the footer' },
      ],
      multiSelect: false,
    },
  ],
};

// A factory with T1 launched at L1 from PRESET, its build run R1 done and
// its review run R2 live.
async function reviewing(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(join(factory.paths.presetsDir, 'shipping.preset.yaml'), PRESET);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'shipping', prompt: 'Add a logout button.' });
  if (!launched.ok) throw new Error(launched.reason);
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  factory.executor.report('R1', { type: 'runCompleted' });
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
  return { factory, operator, tui };
}

describe('the review stage', () => {
  test('is asked to report its findings to the factory', async () => {
    const { factory } = await reviewing();

    const review = factory.executor.started.at(-1)!;
    expect(review.firstMessage).toMatch(/^\/factory:code-review\n\n/);
    expect(review.firstMessage).toContain('report_findings');
  });

  test('with findings, gets one fix pass that resumes its session on them, and moves on once that pass completes', async () => {
    const { factory, tui } = await reviewing();
    factory.executor.report('R2', { type: 'findingsReported', findings: ['The button has no label.', 'logout() swallows errors.'] });

    factory.executor.report('R2', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    const [, review, fix] = factory.executor.started;
    expect(tui.state().runs.R3).toMatchObject({ stage: 'review', mode: 'AFK' });
    expect(fix).toMatchObject({ sessionId: review!.sessionId, resumesSession: true });
    expect(fix!.firstMessage).toContain('- The button has no label.\n- logout() swallows errors.');
    expect(fix!.firstMessage).toContain('report_findings');

    factory.executor.report('R3', { type: 'findingsReported', findings: ['logout() swallows errors.'] });
    factory.executor.report('R3', { type: 'runCompleted' });

    const writing = await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    expect(writing.tasks.T1?.stage).toBe('pr-body');
    expect(factory.executor.started.at(-1)!.firstMessage).toMatch(/^\/factory:pr\n\n/);
  });

  test('taken over and handed back off, is still asked to report its findings', async () => {
    const { factory, operator, tui } = await reviewing();
    await operator.send({ type: 'takeOver', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');

    await handOff(operator, tui, factory.executor, 'T1');

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    expect(factory.executor.started.at(-1)!.firstMessage).toMatch(/^\/factory:code-review\n\n## Factory context\n.*report_findings/);
  });

  test('is given report_findings alone of the factory’s tools, and the PR body stage write_pr_body alone; other stages neither', async () => {
    const { factory, tui } = await reviewing();
    factory.executor.report('R2', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');

    expect(factory.executor.started.map(({ reports }) => reports)).toEqual([[], ['findings'], ['pr-body']]);
  });

  test('a fix pass that reports nothing back leaves every finding over', async () => {
    const { factory, tui } = await reviewing();
    factory.executor.report('R2', { type: 'findingsReported', findings: ['The button has no label.'] });
    factory.executor.report('R2', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');

    factory.executor.report('R3', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    factory.executor.report('R4', { type: 'prBodyWritten', body: 'Adds a logout button.' });

    const written = await tui.until((state) => state.tasks.T1?.prBody !== null);
    expect(written.tasks.T1?.prBody).toBe('Adds a logout button.\n\n## Review findings left over\n\n- The button has no label.');
  });

  test('keeps the findings of a review run that parked on a question, and its next run’s completion starts the fix pass', async () => {
    const { factory, operator, tui } = await reviewing();
    factory.executor.report('R2', { type: 'findingsReported', findings: ['The button has no label.'] });
    factory.executor.report('R2', { type: 'attentionRaised', kind: 'question', question });
    await tui.until((state) => state.runs.R2?.status === 'suspended');
    factory.clock.advance(61 * 60_000);
    await tui.until((state) => state.runs.R2?.outcome === 'parked');
    await operator.send({ type: 'answer', taskId: 'T1', answers: { 'Is the header the right place?': 'Yes' } });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');

    factory.executor.report('R3', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    expect(tui.state().runs.R4?.stage).toBe('review');
    expect(factory.executor.started.at(-1)!.firstMessage).toContain('- The button has no label.');
  });

  test('taken over during its fix pass and handed back off, is told to fix the findings, and moves on once that run completes', async () => {
    const { factory, operator, tui } = await reviewing();
    factory.executor.report('R2', { type: 'findingsReported', findings: ['The button has no label.'] });
    factory.executor.report('R2', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    await operator.send({ type: 'takeOver', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');

    await handOff(operator, tui, factory.executor, 'T1');

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R5');
    const handedBack = factory.executor.started.at(-1)!.firstMessage!;
    expect(handedBack).toContain('- The button has no label.');
    expect(handedBack).not.toContain('Don’t fix them yourself');
    factory.executor.report('R5', { type: 'runCompleted' });
    expect((await tui.until((state) => state.tasks.T1?.liveRunId === 'R6')).tasks.T1?.stage).toBe('pr-body');
  });

  test('with no findings, moves straight on to the PR body', async () => {
    const { factory, tui } = await reviewing();

    factory.executor.report('R2', { type: 'runCompleted' });

    const writing = await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    expect(writing.tasks.T1?.stage).toBe('pr-body');
  });
});

describe('the PR body', () => {
  test('ends with the findings the fix pass left over, and at L1 the root then goes In review, open-pr skipped', async () => {
    const { factory, tui } = await reviewing();
    factory.executor.report('R2', { type: 'findingsReported', findings: ['The button has no label.', 'logout() swallows errors.'] });
    factory.executor.report('R2', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    factory.executor.report('R3', { type: 'findingsReported', findings: ['logout() swallows errors.'] });
    factory.executor.report('R3', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');

    factory.executor.report('R4', { type: 'prBodyWritten', body: 'Adds a logout button to the header.\n' });
    factory.executor.report('R4', { type: 'runCompleted' });

    const reviewed = await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(reviewed.tasks.T1).toMatchObject({ autonomy: 'L1', stage: 'pr-body', liveRunId: null });
    expect(reviewed.tasks.T1?.prBody).toBe('Adds a logout button to the header.\n\n## Review findings left over\n\n- logout() swallows errors.');
    expect(reviewed.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
    expect(factory.executor.started).toHaveLength(4);
  });

  test('a PR body run that wrote none raises a stage-blocked attention request', async () => {
    const { factory, tui } = await reviewing();
    factory.executor.report('R2', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');

    factory.executor.report('R3', { type: 'runCompleted' });

    const blocked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(blocked.attentionQueue).toMatchObject([{ kind: 'attention', taskId: 'T1', reason: 'pr-body’s exit, artifact:pr-body, doesn’t hold: T1 has no pr-body yet.' }]);
  });

  test('lists every ticket the task closed as Implements #n, turning a closing keyword on one to Implements, through main-flow at L1, URL or not', async () => {
    const factory = await startTestFactory();
    factories.push(factory);
    await factory.registerRepo();
    factory.github.addIssue('acme/widgets#10');
    for (const ticket of ['acme/widgets#11', 'acme/widgets#12']) factory.github.addIssue(ticket, { parent: 'acme/widgets#10', labels: ['ready-for-agent'] });
    const operator = await factory.attach();
    const tui = watch(operator);
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', issues: ['#10'] });
    const worktree = (await tui.until((state) => state.tasks.T1?.liveRunId === 'R1')).tasks.T1!.worktree!;
    for (const [runId, path, next] of [['R1', 'src/logout.ts', 'R2'], ['R2', 'src/session.ts', 'R3']] as const) {
      factory.git.editFile(worktree, path);
      factory.git.commitAll(worktree);
      factory.executor.report(runId, { type: 'runCompleted' });
      await tui.until((state) => state.tasks.T1?.liveRunId === next);
    }
    factory.executor.report('R3', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');

    factory.executor.report('R4', { type: 'prBodyWritten', body: 'Adds a logout button.\n\nResolves: https://github.com/acme/widgets/issues/11\nPre-fixes #12 stay.' });
    factory.executor.report('R4', { type: 'runCompleted' });

    const reviewed = await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(reviewed.tasks.T1?.prBody).toBe(
      'Adds a logout button.\n\nImplements https://github.com/acme/widgets/issues/11\nPre-fixes #12 stay.\n\n## Tickets\n\nImplements #12',
    );
    expect(reviewed.tasks.T1?.stage).toBe('pr-body');
  });
});
