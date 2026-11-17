// Seam 1: host cards (ADR 0015), through the client protocol. A contained
// HITL run's egress stays allowlisted through its task's proxy. Each new
// host the proxy denies it raises one host card in its conversation, which
// the operator answers Allow for this task, Allow always (into the
// egress-hosts section of their permissions file) or Deny. Allowing a host
// updates the proxy's allowlist in place, and a card left unanswered parks
// the run, as a permission card does.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { RunView } from '../protocol/factory-state.ts';
import { BUILT_IN_EGRESS } from '../sandbox/sandbox.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

// A preset whose grill is contained.
const PLANNING = [
  'stages:',
  '  - { id: grill, kind: run, skill: grill-me, args: "{{prompt}}", mode: HITL, contained: true }',
  '  - { id: implement, kind: run, skill: implement, args: "{{prompt}}", mode: AFK }',
].join('\n');

async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
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

const launch = (prompt = 'Grill me about the login flow.') => ({ type: 'launchTask', repo: 'acme/widgets', preset: 'planning', prompt }) as const;

async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

// The operator's permissions file, as they wrote it.
function operatorFile(factory: TestFactory, text: string): void {
  mkdirSync(dirname(factory.paths.permissionsPath), { recursive: true });
  writeFileSync(factory.paths.permissionsPath, text);
}

// A contained HITL run, live, whose container was denied `hosts`, each with its card up.
async function denied(...hosts: string[]): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const attachedFactory = await attached();
  const { factory, operator, tui } = attachedFactory;
  await operator.send(launch());
  await started(factory, 1);
  await tui.until((state) => state.runs.R1?.status === 'active');
  for (const host of hosts) expect(factory.sandbox.request('T1', host)).toBe(false);
  factory.clock.advance(HOST_POLL);
  await tui.until((state) => state.runs.R1?.hostCards.length === hosts.length);
  return attachedFactory;
}

// The hosts the run's open host cards name.
const carded = (run: RunView | undefined) => run?.hostCards.map(({ host }) => host);

// Long enough for the daemon to look at what the live runs' containers denied.
const HOST_POLL = 5_000;
const minutes = (n: number) => n * 60_000;

describe('a host a contained HITL run is denied', () => {
  test('raises a host card in its conversation, naming the host, once per new host', async () => {
    const { factory, tui } = await denied('docs.example.com');
    expect(tui.state().runs.R1?.hostCards).toEqual([{ host: 'docs.example.com', problem: null }]);
    expect(tui.state().attentionQueue.filter((item) => item.kind === 'attention')).toEqual([]);

    // Denied again, it raises no second card; a new host raises its own.
    factory.sandbox.request('T1', 'docs.example.com');
    factory.sandbox.request('T1', 'cdn.example.com');
    factory.clock.advance(HOST_POLL);
    const state = await tui.until((state) => state.runs.R1?.hostCards.length === 2);
    expect(carded(state.runs.R1)).toEqual(['docs.example.com', 'cdn.example.com']);
    factory.clock.advance(HOST_POLL * 3);
    expect(carded(tui.state().runs.R1)).toEqual(['docs.example.com', 'cdn.example.com']);
  });

  test('says why the permissions file allowed none of its egress hosts, when it couldn’t', async () => {
    const { factory, operator, tui } = await attached();
    operatorFile(factory, 'egress-hosts: docs.example.com\n');
    await operator.send(launch());
    await started(factory, 1);
    factory.sandbox.request('T1', 'docs.example.com');
    factory.clock.advance(HOST_POLL);
    const state = await tui.until((state) => state.runs.R1?.hostCards.length === 1);
    expect(state.runs.R1?.hostCards).toEqual([
      { host: 'docs.example.com', problem: `${factory.paths.permissionsPath} must hold \`egress-hosts:\`, a list of hosts such as \`docs.example.com\`.` },
    ]);
  });

  test('outlives the agent’s turn: the card stays up once the turn ended', async () => {
    const { factory, operator, tui } = await denied('docs.example.com');
    factory.executor.report('R1', { type: 'turnEnded' });
    await operator.send({ type: 'daemon.status' });
    expect(carded(tui.state().runs.R1)).toEqual(['docs.example.com']);
  });

  test('an L2 run raises none: its denials go on its failure, as before', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: 'acme/widgets#7', autonomy: 'L2' });
    await started(factory, 1);
    factory.sandbox.request('T1', 'pypi.org');
    factory.clock.advance(HOST_POLL * 2);
    await operator.send({ type: 'daemon.status' });
    expect(carded(tui.state().runs.R1)).toEqual([]);
  });
});

describe('answering a host card', () => {
  test('Allow for this task adds the host to the task’s egress hosts and the proxy’s allowlist in place, so the next request goes through', async () => {
    const { factory, operator, tui } = await denied('docs.example.com', 'cdn.example.com');

    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'docs.example.com', answer: 'task' })).toEqual({ ok: true });

    const state = await tui.until((state) => state.runs.R1?.hostCards.length === 1);
    expect(carded(state.runs.R1)).toEqual(['cdn.example.com']);
    expect(state.tasks.T1?.egressHosts).toEqual(['docs.example.com']);
    expect(factory.sandbox.request('T1', 'docs.example.com')).toBe(true);
    expect(factory.sandbox.request('T1', 'cdn.example.com')).toBe(false);
    // No container restart, nor a new prepare.
    expect(factory.sandbox.calls).toEqual(['prepare T1']);
    expect(existsSync(factory.paths.permissionsPath)).toBe(false);
  });

  test('Allow always appends the host to the egress-hosts section of the permissions file, keeping its rules and comments, and every later prepare includes it', async () => {
    const { factory, operator, tui } = await denied('docs.example.com');
    operatorFile(factory, '# Mine, for every task.\nallow:\n  - Bash(make *) # builds\n');

    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'docs.example.com', answer: 'always' })).toEqual({ ok: true });

    const state = await tui.until((state) => state.runs.R1?.hostCards.length === 0);
    expect(readFileSync(factory.paths.permissionsPath, 'utf8')).toBe('# Mine, for every task.\nallow:\n  - Bash(make *) # builds\negress-hosts:\n  - docs.example.com\n');
    expect(state.tasks.T1?.egressHosts).toEqual([]);
    expect(factory.sandbox.request('T1', 'docs.example.com')).toBe(true);

    // Another task's container may reach it from its first prepare.
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: 'acme/widgets#7', autonomy: 'L2' });
    await started(factory, 2);
    expect(factory.sandbox.prepared.at(-1)).toMatchObject({ taskId: 'T2', egress: [...BUILT_IN_EGRESS, 'docs.example.com'] });
  });

  test('Allow always adds no host the file already holds', async () => {
    const { factory, operator } = await denied('docs.example.com');
    operatorFile(factory, 'egress-hosts:\n  - docs.example.com # docs\n');

    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'docs.example.com', answer: 'always' })).toEqual({ ok: true });

    expect(readFileSync(factory.paths.permissionsPath, 'utf8')).toBe('egress-hosts:\n  - docs.example.com # docs\n');
  });

  test('Allow always fails with the reason, leaving the card open and the file as it was, when the file is invalid', async () => {
    const { factory, operator, tui } = await denied('docs.example.com');
    operatorFile(factory, 'egress-hosts: docs.example.com\n');

    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'docs.example.com', answer: 'always' })).toEqual({
      ok: false,
      reason: `Allow always added no host: ${factory.paths.permissionsPath} must hold \`egress-hosts:\`, a list of hosts such as \`docs.example.com\`.`,
    });
    expect(readFileSync(factory.paths.permissionsPath, 'utf8')).toBe('egress-hosts: docs.example.com\n');
    expect(carded(tui.state().runs.R1)).toEqual(['docs.example.com']);
    expect(factory.sandbox.request('T1', 'docs.example.com')).toBe(false);
  });

  test('Allow always fills an empty `egress-hosts:`, keeping its comment, and won’t replace a list it names elsewhere', async () => {
    const { factory, operator } = await denied('docs.example.com', 'cdn.example.com');
    operatorFile(factory, 'egress-hosts: # none yet\n');
    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'docs.example.com', answer: 'always' })).toEqual({ ok: true });
    expect(readFileSync(factory.paths.permissionsPath, 'utf8')).toBe('egress-hosts:\n  - docs.example.com\n  # none yet\n');

    const aliased = 'mine: &mine\n  - docs.example.com\negress-hosts: *mine\n';
    operatorFile(factory, aliased);
    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'cdn.example.com', answer: 'always' })).toEqual({
      ok: false,
      reason: `Allow always added no host: ${factory.paths.permissionsPath} names its \`egress-hosts:\` list elsewhere, so the factory can’t add to it: add the hosts there by hand.`,
    });
    expect(readFileSync(factory.paths.permissionsPath, 'utf8')).toBe(aliased);
  });

  test('Allow always fails with the reason, leaving the card open, when the file can’t be written', async () => {
    const { factory, operator, tui } = await denied('docs.example.com');
    operatorFile(factory, 'allow:\n  - Bash(make *)\n');
    chmodSync(factory.paths.permissionsPath, 0o444);

    const reply = await operator.send({ type: 'answerHost', taskId: 'T1', host: 'docs.example.com', answer: 'always' });
    chmodSync(factory.paths.permissionsPath, 0o644);

    expect(reply).toMatchObject({ ok: false, reason: expect.stringMatching(/^Allow always added no host: .*permissions\.yaml couldn’t be written: /) });
    expect(carded(tui.state().runs.R1)).toEqual(['docs.example.com']);
  });

  test('fails with the reason, leaving the card open and the task’s egress as it was, when the proxy can’t take the host', async () => {
    const { factory, operator, tui } = await denied('docs.example.com');
    factory.sandbox.fail('setEgress', 'the proxy is gone.');

    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'docs.example.com', answer: 'task' })).toEqual({
      ok: false,
      reason: 'The factory couldn’t allow docs.example.com in T1’s egress proxy: the proxy is gone.',
    });
    expect(carded(tui.state().runs.R1)).toEqual(['docs.example.com']);
    expect(tui.state().tasks.T1?.egressHosts).toEqual([]);

    factory.sandbox.fail('setEgress', null);
    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'docs.example.com', answer: 'task' })).toEqual({ ok: true });
    expect(factory.sandbox.request('T1', 'docs.example.com')).toBe(true);
  });

  test('Allow always writes nothing, and the proxy keeps its allowlist, when the proxy can’t take the host', async () => {
    const { factory, operator, tui } = await denied('docs.example.com');
    factory.sandbox.fail('setEgress', 'the proxy is gone.');

    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'docs.example.com', answer: 'always' })).toMatchObject({ ok: false });

    expect(existsSync(factory.paths.permissionsPath)).toBe(false);
    expect(carded(tui.state().runs.R1)).toEqual(['docs.example.com']);
  });

  test('Deny leaves the host blocked and closes the card, and the host raises no second card', async () => {
    const { factory, operator, tui } = await denied('docs.example.com');

    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'docs.example.com', answer: 'deny' })).toEqual({ ok: true });

    await tui.until((state) => state.runs.R1?.hostCards.length === 0);
    expect(factory.sandbox.request('T1', 'docs.example.com')).toBe(false);
    factory.clock.advance(HOST_POLL * 2);
    await operator.send({ type: 'daemon.status' });
    expect(carded(tui.state().runs.R1)).toEqual([]);
    expect(tui.state().tasks.T1?.egressHosts).toEqual([]);
  });

  test('is refused for a host with no card, or an answer that isn’t one', async () => {
    const { operator } = await denied('docs.example.com');
    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'evil.example', answer: 'task' })).toEqual({
      ok: false,
      reason: 'T1 has no host card for evil.example.',
    });
    expect(await operator.send({ type: 'answerHost', taskId: 'T1', host: 'docs.example.com', answer: 'sometimes' as 'task' })).toEqual({
      ok: false,
      reason: 'Allow the host for this task or always, or deny it.',
    });
  });
});

describe('the permissions file’s egress hosts', () => {
  test('every prepare includes them, in lower case, and an invalid section allows none, taking nothing from the file’s rules', async () => {
    const { factory, operator } = await attached();
    operatorFile(factory, 'allow:\n  - Bash(make *)\negress-hosts:\n  - Docs.Example.com\n  - api.github.com\n');
    await operator.send(launch());
    await started(factory, 1);
    expect(factory.sandbox.prepared.at(-1)!.egress).toEqual([...BUILT_IN_EGRESS, 'docs.example.com']);

    operatorFile(factory, 'allow:\n  - Bash(make *)\negress-hosts:\n  - "*.example.com"\n');
    await operator.send(launch('Grill me about sign-out.'));
    await started(factory, 2);
    expect(factory.sandbox.prepared.at(-1)).toMatchObject({ taskId: 'T2', egress: BUILT_IN_EGRESS });

    // A host with a port is no host the proxy names; an IPv6 address is.
    operatorFile(factory, 'egress-hosts:\n  - docs.example.com:443\n');
    await operator.send(launch('Grill me about the session store.'));
    await started(factory, 3);
    expect(factory.sandbox.prepared.at(-1)).toMatchObject({ taskId: 'T3', egress: BUILT_IN_EGRESS });
    operatorFile(factory, 'egress-hosts:\n  - "2001:db8::1"\n');
    await operator.send(launch('Grill me about the audit log.'));
    await started(factory, 4);
    expect(factory.sandbox.prepared.at(-1)).toMatchObject({ taskId: 'T4', egress: [...BUILT_IN_EGRESS, '2001:db8::1'] });
  });
});

describe('a host card left unanswered', () => {
  test('lets the agent work on, then parks the run once its turn ended, as a permission card does, and the later prepare allows a host allowed for the task meanwhile', async () => {
    const { factory, operator, tui } = await denied('docs.example.com', 'cdn.example.com');
    await operator.send({ type: 'answerHost', taskId: 'T1', host: 'cdn.example.com', answer: 'task' });

    // The agent's turn is still under way: a host card holds no call.
    factory.clock.advance(minutes(31));
    await operator.send({ type: 'daemon.status' });
    expect(tui.state().runs.R1?.status).toBe('active');

    factory.executor.report('R1', { type: 'turnEnded' });
    await operator.send({ type: 'daemon.status' });
    factory.clock.advance(minutes(31));
    const state = await tui.until((state) => state.runs.R1?.outcome === 'parked');
    expect(carded(state.runs.R1)).toEqual([]);
    expect(state.tasks.T1?.label).toBe('Ready for you');

    await operator.send({ type: 'open', taskId: 'T1' });
    await started(factory, 2);
    expect(factory.sandbox.prepared.at(-1)!.egress).toEqual([...BUILT_IN_EGRESS, 'cdn.example.com']);
  });
});

