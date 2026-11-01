// Seam 1: the factory identity (ADR 0004) through the client protocol.
// `setup github` creates the App and keeps its private key in the credential
// store alone; each repository says whether the App is installed on it, with
// a fix; a launch whose preset has AFK stages, which work as the App, is
// blocked without it; and
// AFK runs read GitHub through a read-only bot token, refreshed before it
// expires, while HITL runs act as the operator.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

async function attached(options: { withoutApp?: boolean } = {}): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory(options);
  factories.push(factory);
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const widgets = resolve('/clones/widgets');
const register = (factory: TestFactory, operator: FactoryConnection) => {
  factory.git.addClone(widgets, { originUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main' });
  return operator.send({ type: 'registerRepo', path: widgets });
};
const launch = (preset: string, prompt = 'Fix #45'): LaunchCommand => ({ type: 'launchTask', repo: 'acme/widgets', preset, prompt });

// Every file under `dir`, recursively.
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());
}

describe('setup github', () => {
  test('creates the App from the manifest’s code, and its private key exists only in the credential store', async () => {
    const { factory, operator } = await attached({ withoutApp: true });
    const code = factory.github.manifestCode('agents-factory-kevin');

    expect(await operator.send({ type: 'setupGitHub', code })).toEqual({
      ok: true,
      value: { slug: 'agents-factory-kevin', installationSettings: 'https://github.com/apps/agents-factory-kevin/installations/new' },
    });

    const stored = JSON.parse(factory.secrets.stored.get('github-app')!);
    expect(stored).toMatchObject({ slug: 'agents-factory-kevin', privateKey: expect.stringContaining('BEGIN RSA PRIVATE KEY') });
    await factory.daemon().stop();
    const keyLine = stored.privateKey.split('\n')[1];
    for (const file of filesUnder(factory.paths.home)) expect(readFileSync(file, 'latin1')).not.toContain(keyLine);
  });

  test('a code GitHub doesn’t know is refused with GitHub’s reason, and nothing is stored', async () => {
    const { factory, operator } = await attached({ withoutApp: true });

    expect(await operator.send({ type: 'setupGitHub', code: 'stale' })).toEqual({
      ok: false,
      reason: 'The factory’s GitHub App couldn’t be created: GitHub refused to create the App from its manifest (HTTP 404: Not Found).',
    });
    expect(factory.secrets.stored.size).toBe(0);
  });
});

describe('whether the App is installed on a repository', () => {
  test('a repository without the App shows that, with a fix that opens the installation settings', async () => {
    const { factory, operator, tui } = await attached();

    expect(await register(factory, operator)).toMatchObject({
      ok: true,
      value: {
        app: {
          installed: false,
          checkedAt: factory.clock.now(),
          reason: 'The factory’s GitHub App, agents-factory-operator, isn’t installed on acme/widgets.',
          fixUrl: 'https://github.com/apps/agents-factory-operator/installations/new',
        },
      },
    });
    expect((await tui.until((state) => 'acme/widgets' in state.repositories)).repositories['acme/widgets']!.app).toMatchObject({ installed: false });
  });

  test('once the operator installs it, checking again caches that on the repository', async () => {
    const { factory, operator, tui } = await attached();
    await register(factory, operator);
    factory.github.install('acme/widgets');
    factory.clock.advance(60_000);

    expect(await operator.send({ type: 'checkApp', repo: 'acme/widgets' })).toEqual({
      ok: true,
      value: { installed: true, checkedAt: factory.clock.now() },
    });
    await tui.until((state) => state.repositories['acme/widgets']?.app?.installed === true);
  });

  test('every repository is checked again when the daemon starts', async () => {
    const { factory, operator } = await attached();
    await register(factory, operator);
    factory.github.install('acme/widgets');

    await factory.restart();

    const tui = watch(await factory.attach());
    await tui.until((state) => state.repositories['acme/widgets']?.app?.installed === true);
  });

  test('without an App, the fix is `setup github`, and setting it up checks every repository again', async () => {
    const { factory, operator, tui } = await attached({ withoutApp: true });

    expect(await register(factory, operator)).toMatchObject({
      ok: true,
      value: {
        app: { installed: false, reason: 'The factory has no GitHub App yet: run `agents-factory setup github` to create it.', fixUrl: null },
      },
    });

    await operator.send({ type: 'setupGitHub', code: factory.github.manifestCode('agents-factory-kevin') });
    await tui.until((state) => state.repositories['acme/widgets']?.app?.installed === false && state.repositories['acme/widgets'].app.fixUrl !== null);
  });

  test('when GitHub can’t be reached, the repository says the check failed and why', async () => {
    const { factory, operator } = await attached();
    factory.github.unreachable('GitHub couldn’t be reached: getaddrinfo ENOTFOUND api.github.com');

    expect(await register(factory, operator)).toMatchObject({
      ok: true,
      value: {
        app: {
          installed: false,
          reason:
            'The factory couldn’t check whether its GitHub App is installed on acme/widgets: GitHub couldn’t be reached: getaddrinfo ENOTFOUND api.github.com',
          fixUrl: null,
        },
      },
    });
  });
});

describe('launching where the App isn’t installed', () => {
  test('a preset with AFK stages is blocked with a reason, whether or not they write, and one without isn’t', async () => {
    const { factory, operator, tui } = await attached();
    await register(factory, operator);

    expect(await operator.send(launch('main-flow'))).toEqual({
      ok: false,
      reason:
        'main-flow works unattended as the factory’s App (at implement, review, pr-body, open-pr). ' +
        'The factory’s GitHub App, agents-factory-operator, isn’t installed on acme/widgets. ' +
        'Install it from https://github.com/apps/agents-factory-operator/installations/new, then launch again.',
    });
    // Its one AFK run writes nothing to GitHub, but reads it as the App.
    expect(await operator.send(launch('child'))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^child works unattended as the factory’s App \(at work\)\./),
    });
    expect(await operator.send(launch('setup', ''))).toEqual({ ok: true, value: { taskId: 'T1' } });
    expect(Object.keys(tui.state().tasks)).toEqual(['T1']);
  });

  test('the launch checks afresh, so it goes ahead once the operator has installed the App', async () => {
    const { factory, operator } = await attached();
    await register(factory, operator);
    factory.github.install('acme/widgets');

    expect(await operator.send(launch('implement'))).toEqual({ ok: true, value: { taskId: 'T1' } });
  });
});

describe('what a run reads GitHub as', () => {
  async function running(preset: string) {
    const attachedFactory = await attached();
    const { factory, operator, tui } = attachedFactory;
    factory.github.install('acme/widgets');
    await register(factory, operator);
    await operator.send(launch(preset));
    await tui.until((state) => state.runs.R1?.status === 'active');
    await until(() => factory.executor.started.length === 1);
    return { ...attachedFactory, run: factory.executor.started[0]! };
  }

  const hostsOf = (configDir: string) => readFileSync(join(configDir, 'hosts.yml'), 'utf8');

  test('an AFK run reads through a read-only bot token for its repository, in a GH_CONFIG_DIR of its own', async () => {
    const { factory, run } = await running('implement');

    expect(factory.github.minted).toEqual([
      { repo: 'acme/widgets', permissions: { issues: 'read', pull_requests: 'read', metadata: 'read' }, token: 'ghs_fake1', expiresAt: expect.any(Number) },
    ]);
    const configDir = run.guards!.env.GH_CONFIG_DIR!;
    expect(configDir.startsWith(factory.paths.runsRoot)).toBe(true);
    expect(hostsOf(configDir)).toContain('oauth_token: ghs_fake1');
    expect(hostsOf(configDir)).toContain('agents-factory-operator[bot]');
    expect(run.guards!.env).toMatchObject({ GH_PROMPT_DISABLED: '1' });
  });

  test('the token is refreshed in place before it expires, mid-run', async () => {
    const { factory, run } = await running('implement');
    const configDir = run.guards!.env.GH_CONFIG_DIR!;

    factory.clock.advance(45 * 60_000);
    expect(factory.github.minted).toHaveLength(1);

    factory.clock.advance(10 * 60_000);
    await until(() => hostsOf(configDir).includes('ghs_fake2'));
    expect(factory.github.minted.map(({ token }) => token)).toEqual(['ghs_fake1', 'ghs_fake2']);
    expect(hostsOf(configDir)).not.toContain('ghs_fake1');
  });

  test('a refresh that fails is tried again a minute later, while the run keeps its token', async () => {
    const { factory, run } = await running('implement');
    const configDir = run.guards!.env.GH_CONFIG_DIR!;
    factory.github.unreachable('GitHub couldn’t be reached: socket hang up');

    factory.clock.advance(51 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    factory.github.unreachable(null);
    factory.clock.advance(30_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(factory.github.minted).toHaveLength(1);
    expect(hostsOf(configDir)).toContain('ghs_fake1');

    factory.clock.advance(30_000);
    await until(() => hostsOf(configDir).includes('ghs_fake2'));
  });

  test('a HITL run acts as the operator’s own gh login: it gets no bot token', async () => {
    const { factory, run } = await running('main-flow');

    expect(run.mode).toBe('HITL');
    expect(run.guards).toBeNull();
    expect(factory.github.minted).toEqual([]);
  });

  test('an AFK run whose bot token can’t be minted when it starts fails with the reason', async () => {
    const { factory, operator, tui } = await running('child');
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(launch('child'));
    await tui.until((state) => state.tasks.T2?.label === 'Queued');
    factory.github.unreachable('GitHub couldn’t be reached: socket hang up');

    factory.executor.report('R1', { type: 'runCompleted' });

    const state = await tui.until((state) => state.tasks.T2?.state === 'waiting');
    expect(state.attentionQueue.find((item) => item.taskId === 'T2')).toMatchObject({
      kind: 'attention',
      reason: 'The factory couldn’t give the run its read-only GitHub token: GitHub couldn’t be reached: socket hang up',
    });
    expect(factory.executor.started.map((run) => run.taskId)).toEqual(['T1']);
  });
});

async function until(test: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() > deadline) throw new Error('The condition never held.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
