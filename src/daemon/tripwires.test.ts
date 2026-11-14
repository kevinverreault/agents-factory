// Seam 1: semi-auto's tripwires (ADR 0014), through the client protocol.
// Under `judged`, once a gated PR's checks are green, its tripwires are
// evaluated first, without a model, on the commits the factory's own AFK
// runs authored since the base: one that fires puts the task In review
// naming the tripwire and what tripped it, and no judging run starts. The
// operator's own commits trip nothing. The tripwires are the task's frozen
// gate config, so the operator's file can drop one for a repository, and
// under `unattended` none is evaluated.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { FAKE_OPERATOR_EMAIL } from '../testing/fake-git.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const MINUTE = 60_000;

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

async function attached(): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

const launch = (mergePolicy: 'judged' | 'unattended'): LaunchCommand => ({
  type: 'launchTask',
  repo: 'acme/widgets',
  preset: 'implement',
  prompt: 'Add a logout button.',
  autonomy: 'L3',
  mergePolicy,
});

async function nextRun({ tui }: Factory, taskId: string, after: string | null): Promise<string> {
  return (await tui.until((state) => !!state.tasks[taskId]?.liveRunId && state.tasks[taskId].liveRunId !== after)).tasks[taskId]!.liveRunId!;
}

// A commit in the task's container writing `files` (null deletes one), by
// the factory's identity unless `author` says otherwise.
type Commit = { files: Record<string, string | null>; author?: string };

function commit(factory: TestFactory, taskId: string, { files, author }: Commit): void {
  const workdir = factory.sandbox.workdirOf(taskId);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) factory.git.deleteFile(workdir, path);
    else factory.git.editFile(workdir, path, content);
  }
  factory.git.commitAll(workdir, author ? { author } : {});
}

// Works T1 through its implement run, which makes `commits`, its review,
// which leaves `highSeverity` over as high-severity findings, and its PR
// body run, to its PR #101 at its gate, checks pending. Returns its last run.
async function throughPr(launched: Factory, commits: Commit[], { highSeverity = [] }: { highSeverity?: string[] } = {}): Promise<string> {
  const { factory, tui } = launched;
  factory.github.runChecks('acme/widgets', 'pending');
  let run = await nextRun(launched, 'T1', null);
  for (const made of commits) commit(factory, 'T1', made);
  factory.executor.report(run, { type: 'runCompleted' });
  run = await nextRun(launched, 'T1', run);
  if (highSeverity.length) {
    const findings = [...highSeverity.map((finding) => ({ finding, severity: 'high' as const })), { finding: 'The button has no label.', severity: 'low' as const }];
    factory.executor.report(run, { type: 'findingsReported', findings });
    factory.executor.report(run, { type: 'runCompleted' });
    run = await nextRun(launched, 'T1', run);
    factory.executor.report(run, { type: 'findingsReported', findings });
  }
  factory.executor.report(run, { type: 'runCompleted' });
  run = await nextRun(launched, 'T1', run);
  factory.executor.report(run, { type: 'prBodyWritten', body: 'The work of T1.' });
  factory.executor.report(run, { type: 'runCompleted' });
  await tui.until((state) => state.tasks.T1?.gate?.checks === 'pending');
  return run;
}

// The checks on PR #101 go green, and the next poll reads them.
function green({ factory }: Factory): void {
  factory.github.setChecks(101, 'green');
  factory.clock.advance(2 * MINUTE);
}

// The task goes In review, sent to the operator for `reason`, with no
// judging run started and nothing merged.
async function sentToOperator(launched: Factory, reason: string): Promise<void> {
  const { factory, tui } = launched;
  const runs = factory.executor.started.length;
  const asked = await tui.until((state) => state.tasks.T1?.label === 'In review');
  expect(asked.tasks.T1).toMatchObject({ sentToOperator: reason, gate: null });
  expect(asked.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1', reason }]);
  // Polled again, the same head starts no judging run.
  factory.clock.advance(2 * MINUTE);
  await vi.waitFor(() => expect(factory.github.prReads.length).toBeGreaterThan(1));
  expect(factory.executor.started).toHaveLength(runs);
  expect(factory.executor.started.some((started) => started.reports?.includes('verdict'))).toBe(false);
  expect(factory.github.prState(101).state).toBe('open');
  expect(factory.github.prWrites).toEqual([]);
}

// The judging run starts.
async function judges(launched: Factory, after: string): Promise<void> {
  const run = await nextRun(launched, 'T1', after);
  expect(launched.factory.executor.started.find((started) => started.runId === run)!.reports).toEqual(['verdict']);
  expect(launched.tui.state().tasks.T1!.sentToOperator).toBeNull();
}

describe('semi-auto’s tripwires', () => {
  test('the factory’s commits touching a tripwired path put the task In review naming the tripwire and the path, and no judging run starts', async () => {
    const launched = await attached();
    await launched.operator.send(launch('judged'));
    await throughPr(launched, [{ files: { 'src/logout.ts': 'export {};\n' } }, { files: { '.github/CODEOWNERS': '* @acme/widgets\n' } }]);

    green(launched);

    await sentToOperator(launched, 'The tripwire .github/** fired: the factory’s commits touch .github/CODEOWNERS.');
  });

  test('the same path changed only in an operator-authored commit trips nothing, and the judging run starts', async () => {
    const launched = await attached();
    await launched.operator.send(launch('judged'));
    const last = await throughPr(launched, [
      { files: { 'docs/adr/0001-cookies.md': '# Cookies\n', 'GLOSSARY.md': '# Glossary\n' }, author: FAKE_OPERATOR_EMAIL },
      { files: { 'src/logout.ts': 'export {};\n' } },
    ]);

    green(launched);

    await judges(launched, last);
  });

  test('a dependency manifest changed beyond the lockfile trips dependency-change', async () => {
    const launched = await attached();
    await launched.operator.send(launch('judged'));
    await throughPr(launched, [{ files: { 'package.json': '{ "dependencies": { "left-pad": "1.3.0" } }\n', 'package-lock.json': '{}\n' } }]);

    green(launched);

    await sentToOperator(launched, 'The tripwire dependency-change fired: the factory’s commits change the dependency manifest package.json.');
  });

  test('a lockfile changed alone trips nothing', async () => {
    const launched = await attached();
    await launched.operator.send(launch('judged'));
    const last = await throughPr(launched, [{ files: { 'package-lock.json': '{}\n' } }]);

    green(launched);

    await judges(launched, last);
  });

  test('a test file deleted, or a test skipped, trips tests-removed-or-skipped', async () => {
    const launched = await attached();
    await launched.operator.send(launch('judged'));
    const last = await throughPr(launched, [
      { files: { 'src/login.test.ts': "test('logs in');\n", 'src/logout.test.ts': "test('logs out');\n" }, author: FAKE_OPERATOR_EMAIL },
      { files: { 'src/login.test.ts': null } },
    ]);

    green(launched);

    await sentToOperator(launched, 'The tripwire tests-removed-or-skipped fired: in the factory’s commits, src/login.test.ts is deleted.');

    // A new commit sends it back to its gate, its tripwires evaluated afresh on the new head.
    const { factory, operator, tui } = launched;
    expect(await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'Run the tests in CI.' })).toEqual({ ok: true });
    const changes = await nextRun(launched, 'T1', last);
    commit(factory, 'T1', { files: { '.github/CODEOWNERS': '* @acme/widgets\n' } });
    factory.executor.report(changes, { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.gate?.checks === 'pending');
    green(launched);
    await sentToOperator(launched, 'The tripwire .github/** fired: the factory’s commits touch .github/CODEOWNERS.');
  });

  test('a high-severity finding left over after fix-once trips high-severity-finding', async () => {
    const launched = await attached();
    await launched.operator.send(launch('judged'));
    await throughPr(launched, [{ files: { 'src/logout.ts': 'export {};\n' } }], { highSeverity: ['logout() leaves the session cookie set.'] });

    green(launched);

    await sentToOperator(launched, 'The tripwire high-severity-finding fired: the review left a high-severity finding over: logout() leaves the session cookie set.');
  });

  test('a tripwire removed in the operator’s file’s section for the repository no longer fires there', async () => {
    const launched = await attached();
    writeFileSync(launched.factory.paths.mergeGatePath, ['repositories:', '  acme/widgets:', '    tripwires:', '      paths: ["**/migrations/**"]', ''].join('\n'));
    await launched.operator.send(launch('judged'));
    const last = await throughPr(launched, [{ files: { '.github/CODEOWNERS': '* @acme/widgets\n' } }]);

    green(launched);

    await judges(launched, last);
  });

  test('a head whose changes can’t be read sends the task to the operator unjudged', async () => {
    const launched = await attached();
    await launched.operator.send(launch('judged'));
    await throughPr(launched, [{ files: { 'src/logout.ts': 'export {};\n' } }]);
    // GitHub reports a head no fetch brings into the clone.
    launched.factory.github.reportHead(101, 'f'.repeat(40));
    launched.factory.github.setCommitChecks('f'.repeat(40), 'green');
    launched.factory.clock.advance(2 * MINUTE);

    const asked = await launched.tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(asked.tasks.T1!.sentToOperator).toMatch(/^The tripwires couldn’t be checked on fffffff: /);
    expect(launched.factory.executor.started.some((started) => started.reports?.includes('verdict'))).toBe(false);
  });

  test('a base that can’t be fetched sends the task to the operator unjudged, saying so', async () => {
    const launched = await attached();
    await launched.operator.send(launch('judged'));
    await throughPr(launched, [{ files: { 'src/logout.ts': 'export {};\n' } }]);
    launched.factory.git.cutOffOrigin(resolve('/clones/widgets'), 'fatal: unable to access origin');

    green(launched);

    const asked = await launched.tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(asked.tasks.T1!.sentToOperator).toMatch(/^The tripwires couldn’t be checked on \w{7}: Couldn't fetch main from the origin of acme\/widgets: fatal: unable to access origin$/);
    expect(launched.factory.executor.started.some((started) => started.reports?.includes('verdict'))).toBe(false);
  });

  test('under full-auto no tripwire is evaluated: the PR merges once green', async () => {
    const launched = await attached();
    await launched.operator.send(launch('unattended'));
    await throughPr(launched, [{ files: { '.github/CODEOWNERS': '* @acme/widgets\n', 'package.json': '{}\n' } }], { highSeverity: ['logout() leaves the session cookie set.'] });

    green(launched);

    await launched.tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(launched.factory.github.prState(101).state).toBe('merged');
  });
});
