// `setup github` against a fake protocol client: the operator's browser
// posts the factory's manifest to GitHub from a local page, and GitHub's
// redirect back hands the code to the daemon, which alone creates the App
// and stores its key.
import { afterEach, describe, expect, test } from 'vitest';
import { FakeConnection } from '../testing/fake-connection.ts';
import { setUpGitHub } from './setup-command.ts';

// Each command started, given up on once its test ends.
const running: { exit: Promise<number>; abort: AbortController }[] = [];
afterEach(async () => {
  for (const { exit, abort } of running.splice(0)) {
    abort.abort();
    await exit;
  }
});

// Starts the command, and resolves with the local page it opened.
async function started(connection: FakeConnection) {
  const printed: string[] = [];
  let opened!: (url: string) => void;
  const page = new Promise<string>((resolve) => (opened = resolve));
  const abort = new AbortController();
  const exit = setUpGitHub({ connection, name: 'agents-factory-kevin', openUrl: opened, print: (line) => printed.push(line), signal: abort.signal });
  running.push({ exit, abort });
  return { page: new URL(await page), exit, printed };
}

// The manifest form on the local page, as the browser would post it.
async function formOf(page: URL): Promise<{ action: URL; manifest: Record<string, any> }> {
  const html = await (await fetch(page)).text();
  const action = /<form[^>]*action="([^"]+)"/.exec(html)![1]!.replaceAll('&amp;', '&');
  const value = /name="manifest" value="([^"]*)"/.exec(html)![1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  return { action: new URL(action), manifest: JSON.parse(value) };
}

describe('setup github', () => {
  test('the local page posts a manifest of the App’s permissions to GitHub, protected by a state', async () => {
    const { page } = await started(new FakeConnection());

    expect(page.hostname).toBe('127.0.0.1');
    const { action, manifest } = await formOf(page);
    expect(`${action.origin}${action.pathname}`).toBe('https://github.com/settings/apps/new');
    expect(action.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(manifest).toMatchObject({
      name: 'agents-factory-kevin',
      public: false,
      redirect_url: `${page.origin}/created`,
      default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' },
      default_events: [],
      hook_attributes: { active: false },
    });
  });

  test('GitHub’s redirect hands the code to the daemon and sends the browser on to install the App', async () => {
    const connection = new FakeConnection();
    const installationSettings = 'https://github.com/apps/agents-factory-kevin/installations/new';
    connection.replyTo('setupGitHub', { ok: true, value: { slug: 'agents-factory-kevin', installationSettings } });
    const { page, exit, printed } = await started(connection);
    const state = (await formOf(page)).action.searchParams.get('state');

    const redirect = await fetch(`${page.origin}/created?code=abc123&state=${state}`, { redirect: 'manual' });

    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(installationSettings);
    expect(connection.sent).toEqual([{ type: 'setupGitHub', code: 'abc123' }]);
    expect(await exit).toBe(0);
    expect(printed.at(-1)).toBe(`Created the factory’s GitHub App, agents-factory-kevin. Install it on your repositories: ${installationSettings}`);
  });

  test('a redirect without the state the page posted is refused, and nothing reaches the daemon', async () => {
    const connection = new FakeConnection();
    const { page } = await started(connection);

    const forged = await fetch(`${page.origin}/created?code=abc123&state=0000`, { redirect: 'manual' });

    expect(forged.status).toBe(400);
    expect(connection.sent).toEqual([]);
  });

  test('the daemon’s refusal is shown in the browser and ends the command with its reason', async () => {
    const connection = new FakeConnection();
    const reason = 'The factory’s GitHub App couldn’t be created: GitHub refused to create the App from its manifest (HTTP 404: Not Found).';
    connection.replyTo('setupGitHub', { ok: false, reason });
    const { page, exit, printed } = await started(connection);
    const state = (await formOf(page)).action.searchParams.get('state');

    const reply = await fetch(`${page.origin}/created?code=stale&state=${state}`);

    expect(reply.status).toBe(502);
    expect(await reply.text()).toContain('GitHub refused to create the App from its manifest');
    expect(await exit).toBe(1);
    expect(printed.at(-1)).toBe(reason);
  });
});
