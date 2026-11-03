// Seam 1: publishing an L1 root (ADR 0004, ADR 0007). At L1 the task's code
// stays on the operator's machine until they choose Push & open draft PR on
// the root in review: the factory then pushes the task branch as its App,
// with a token narrowed to Contents and a fixed refspec, and opens a draft
// PR assigned to the operator, with a footer naming the task, each stage's
// model and the tokens it took. A branch changing workflow files is the
// operator's to push by hand.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';
const clone = resolve('/clones/widgets');
const branch = 'factory/T1-add-a-logout-button';
const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost: 0 });

// A factory with T1 launched at L1 from a preset that builds, writes its PR
// body and opens its PR at L2 only: its build run R1 committed `files`, its
// PR body run R2 wrote the body, and the root is In review.
async function inReview(files: Record<string, string> = { 'src/logout.ts': 'export {};\n' }): Promise<{
  factory: TestFactory;
  operator: FactoryConnection;
  tui: Watched;
  tip: string;
}> {
  const factory = await startTestFactory();
  factories.push(factory);
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(
    join(factory.paths.presetsDir, 'unattended.preset.yaml'),
    [
      'stages:',
      '  - { id: build, kind: run, mode: AFK, skill: implement, args: "{{prompt}}", exit: run-completed }',
      '  - { id: pr-body, kind: run, mode: AFK, skill: pr, model: haiku, exit: "artifact:pr-body" }',
      '  - { id: open-pr, kind: action, mode: AFK, requires: L2 }',
      '',
    ].join('\n'),
  );
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt: 'Add a logout button.' });
  if (!launched.ok) throw new Error(launched.reason);
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  const worktree = tui.state().tasks.T1!.worktree!;
  for (const [path, content] of Object.entries(files)) factory.git.editFile(worktree, path, content);
  factory.git.commitAll(worktree);
  factory.executor.report('R1', { type: 'usageTotaled', models: { [SONNET]: usage(4_000, 1_000) } });
  factory.executor.report('R1', { type: 'runCompleted' });
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
  factory.executor.report('R2', { type: 'prBodyWritten', body: 'Adds a logout button to the header.' });
  factory.executor.report('R2', { type: 'usageTotaled', models: { [HAIKU]: usage(2_000, 500) } });
  factory.executor.report('R2', { type: 'runCompleted' });
  await tui.until((state) => state.tasks.T1?.label === 'In review');
  return { factory, operator, tui, tip: factory.git.branchTip(clone, branch)! };
}

describe('Push & open draft PR on an L1 root in review', () => {
  test('pushes the task branch with a token narrowed to Contents, then opens a draft PR assigned to the operator, with the factory’s footer', async () => {
    const { factory, operator, tui, tip } = await inReview();

    expect(await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' })).toEqual({ ok: true });

    const published = await tui.until((state) => state.tasks.T1?.pr !== null);
    expect(published.tasks.T1).toMatchObject({ label: 'In review', pr: { number: 101, url: 'https://github.com/acme/widgets/pull/101', draft: true }, publishing: null });
    expect(factory.github.pushes).toEqual([
      { repo: 'acme/widgets', branch, tip, token: expect.objectContaining({ repo: 'acme/widgets', permissions: { contents: 'write', metadata: 'read' } }) },
    ]);
    expect(factory.git.originTip(clone, branch)).toBe(tip);
    expect(factory.github.pullRequests).toEqual([
      expect.objectContaining({
        repo: 'acme/widgets',
        draft: true,
        head: branch,
        base: 'main',
        title: 'Add a logout button.',
        assignees: ['octo-operator'],
        token: expect.objectContaining({ repo: 'acme/widgets', permissions: { contents: 'read', pull_requests: 'write', metadata: 'read' } }),
      }),
    ]);
    expect(factory.github.pullRequests[0]!.body).toBe(
      [
        'Adds a logout button to the header.',
        '',
        '---',
        'Opened by the agents factory for task T1.',
        '',
        '| Stage | Model |',
        '| --- | --- |',
        `| build | ${SONNET} |`,
        `| pr-body | ${HAIKU} |`,
        '',
        'Total tokens: 7,500',
      ].join('\n'),
    );
    expect(published.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
  });

  test('opens a regular PR where GitHub offers no draft PRs, as on a private repository under GitHub Free', async () => {
    const { factory, operator, tui } = await inReview();
    factory.github.offerNoDrafts('acme/widgets');

    await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });

    const published = await tui.until((state) => state.tasks.T1?.pr !== null);
    expect(published.tasks.T1).toMatchObject({ pr: { number: 101, url: 'https://github.com/acme/widgets/pull/101', draft: false }, publishing: null });
    expect(factory.github.pullRequests).toEqual([expect.objectContaining({ draft: false, head: branch, assignees: ['octo-operator'] })]);
    expect(published.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
  });
});

describe('a failed GitHub write', () => {
  test('raises an attention request and leaves the root In review, and answering it tries the step again, never as the operator', async () => {
    const { factory, operator, tui, tip } = await inReview();
    factory.github.uninstall('acme/widgets');

    await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });

    const asked = await tui.until((state) => state.attentionQueue.length === 2);
    expect(asked.attentionQueue[0]).toMatchObject({
      attention: 'github-write',
      reason: `The factory couldn’t push ${branch} on GitHub as its App: The factory’s App isn’t installed on acme/widgets. Fix it, then answer to try again.`,
    });
    expect(asked.tasks.T1).toMatchObject({ label: 'In review', publishing: { step: 'push' } });
    expect(factory.git.originTip(clone, branch)).toBeNull();

    factory.github.install('acme/widgets');
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });

    const published = await tui.until((state) => state.tasks.T1?.pr !== null);
    expect(factory.git.originTip(clone, branch)).toBe(tip);
    expect(published.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
  });

  test('waiting on the operator doesn’t hold the review up: Mark done closes its request', async () => {
    const { factory, operator, tui } = await inReview();
    factory.github.uninstall('acme/widgets');
    await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });
    await tui.until((state) => state.attentionQueue.length === 2);

    expect(await operator.send({ type: 'markDone', taskId: 'T1', anyway: true })).toEqual({ ok: true });

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(done.tasks.T1?.publishing).toBeNull();
    expect(done.attentionQueue).toEqual([]);
  });

  test('of the draft PR comes after the push, and answering opens the PR without pushing again', async () => {
    const { factory, operator, tui } = await inReview();
    factory.github.failPullRequests('GitHub couldn’t be reached: ECONNRESET');

    await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });

    const asked = await tui.until((state) => state.attentionQueue.length === 2);
    expect(asked.attentionQueue[0]).toMatchObject({
      attention: 'github-write',
      reason: 'The factory couldn’t open T1’s draft PR on GitHub as its App: GitHub couldn’t be reached: ECONNRESET Fix it, then answer to try again.',
    });
    expect(factory.github.pushes).toHaveLength(1);

    factory.github.failPullRequests(null);
    await operator.send({ type: 'answer', taskId: 'T1' });

    await tui.until((state) => state.tasks.T1?.pr !== null);
    expect(factory.github.pushes).toHaveLength(1);
    expect(factory.github.pullRequests).toHaveLength(1);
  });
});

describe('Push & open draft PR', () => {
  test('is refused unless the root is in review, and while it is under way, and Mark done and Request changes wait for it', async () => {
    const { factory, operator, tui } = await inReview();
    const writes = factory.github.holdWrites();

    expect(await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' })).toEqual({ ok: true });
    await writes.held;

    expect(await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' })).toEqual({ ok: false, reason: 'T1 is already pushing and opening its draft PR.' });
    const waiting = { ok: false, reason: 'T1 is pushing and opening its draft PR: wait for it to finish.' };
    expect(await operator.send({ type: 'markDone', taskId: 'T1', anyway: true })).toEqual(waiting);
    expect(await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'Bold it.' })).toEqual(waiting);
    writes.release();
    await tui.until((state) => state.tasks.T1?.pr !== null);

    await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'Bold it.' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    expect(await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' })).toEqual({ ok: false, reason: 'T1 is not in review.' });
  });

  test('is the L1 root’s alone: a HITL root’s work stays the operator’s to publish (ADR 0004)', async () => {
    const factory = await startTestFactory();
    factories.push(factory);
    mkdirSync(factory.paths.presetsDir, { recursive: true });
    writeFileSync(join(factory.paths.presetsDir, 'talk.preset.yaml'), 'stages:\n  - { id: talk, kind: run, mode: HITL, skill: grill-me, args: "{{prompt}}" }\n');
    await factory.registerRepo();
    const operator = await factory.attach();
    const tui = watch(operator);
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'talk', prompt: 'Add a logout button.' });
    await tui.until((state) => state.runs.R1?.status === 'active');
    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.label === 'In review');

    expect(await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'T1 is HITL work, which stays yours: push its branch and open its PR yourself.',
    });
    expect(factory.github.pushes).toEqual([]);
  });

  test('again once the root has its draft PR pushes the new commits to it, opening no other', async () => {
    const { factory, operator, tui } = await inReview();
    await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.pr !== null);
    await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'Bold it.' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    const worktree = tui.state().tasks.T1!.worktree!;
    factory.git.editFile(worktree, 'src/logout.ts', 'export const bold = true;\n');
    factory.git.commitAll(worktree);
    factory.executor.report('R3', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'In review');

    await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });

    await tui.until((state) => state.tasks.T1?.publishing === null && factory.github.pushes.length === 2);
    expect(factory.git.originTip(clone, branch)).toBe(factory.git.branchTip(clone, branch));
    expect(factory.github.pullRequests).toHaveLength(1);
    expect(tui.state().tasks.T1?.pr).toEqual({ number: 101, url: 'https://github.com/acme/widgets/pull/101', draft: true });
  });

  test('a daemon that stopped mid-way carries on from the step it was at', async () => {
    const { factory, operator, tui } = await inReview();
    const writes = factory.github.holdWrites();
    await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });
    await writes.held;

    const stopping = factory.daemon().stop();
    writes.release();
    await stopping;
    await factory.startDaemon();

    const after = watch(await factory.attach());
    await after.until((state) => state.tasks.T1?.pr != null);
    expect(factory.github.pullRequests).toHaveLength(1);
  });
});

describe('a task branch that changes workflow files', () => {
  test('isn’t pushed: an attention request asks the operator to push it by hand, and once they have and answer, the draft PR opens', async () => {
    const { factory, operator, tui, tip } = await inReview({ '.github/workflows/ci.yml': 'on: push\n', 'src/logout.ts': 'export {};\n' });

    await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });

    const asked = await tui.until((state) => state.attentionQueue.length === 2);
    expect(asked.attentionQueue[0]).toMatchObject({
      kind: 'attention',
      taskId: 'T1',
      attention: 'github-write',
      reason:
        `${branch} changes workflow files (.github/workflows/ci.yml), which the factory’s App may not push. ` +
        `Push it by hand (\`git push origin ${branch}\`), then answer to open the draft PR.`,
    });
    expect(asked.attentionQueue[1]).toEqual({ kind: 'review', taskId: 'T1' });
    expect(asked.tasks.T1).toMatchObject({ label: 'In review', pr: null });
    expect(factory.github.pushes).toEqual([]);
    expect(factory.git.originTip(clone, branch)).toBeNull();

    factory.git.push(clone, branch);
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });

    const published = await tui.until((state) => state.tasks.T1?.pr !== null);
    expect(published.tasks.T1).toMatchObject({ label: 'In review', publishing: null });
    expect(factory.github.pullRequests).toMatchObject([{ head: branch, draft: true }]);
    expect(factory.github.pushes).toEqual([]);
    expect(factory.git.originTip(clone, branch)).toBe(tip);
    expect(published.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
  });
});
