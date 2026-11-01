// `agents-factory setup github`: creates the factory identity's App through
// GitHub's manifest flow (ADR 0004). A page served on 127.0.0.1 posts the
// manifest from the operator's browser to GitHub, and GitHub redirects back
// to it with a code. The code goes to the daemon, which alone turns it into
// the App and writes its private key straight into the credential store:
// the key never passes through this process, and never touches disk.
import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FactoryConnection } from '../protocol/client.ts';
import type { SetupView } from '../protocol/protocol.ts';
import { APP_PERMISSIONS } from './github.ts';

const HOMEPAGE = 'https://github.com/kevinverreault/agents-factory';

export type SetupOptions = {
  connection: Pick<FactoryConnection, 'send'>;
  // The App's name on GitHub, which every GitHub App must have to itself.
  name: string;
  openUrl(url: string): void;
  print(line: string): void;
  // Gives up waiting for GitHub's redirect.
  signal?: AbortSignal;
};

// The manifest of the App: its permissions and nothing else, owned by the
// operator alone, with no webhook.
export function appManifest(name: string, redirectUrl: string) {
  return {
    name,
    url: HOMEPAGE,
    description: 'The factory identity of an agents-factory: it writes to GitHub for AFK work.',
    public: false,
    redirect_url: redirectUrl,
    hook_attributes: { url: HOMEPAGE, active: false },
    default_permissions: APP_PERMISSIONS,
    default_events: [],
  };
}

// Resolves with the command's exit code once GitHub has redirected back and
// the daemon has answered.
export async function setUpGitHub({ connection, name, openUrl, print, signal }: SetupOptions): Promise<number> {
  // GitHub echoes it back, so a redirect forged by another page is told apart.
  const state = randomBytes(16).toString('hex');
  let finish!: (code: number) => void;
  const finished = new Promise<number>((resolve) => (finish = resolve));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return page(response, 200, formPage(appManifest(name, `${origin()}/created`), state));
    if (url.pathname !== '/created') return page(response, 404, '<p>Not found.</p>');
    const code = url.searchParams.get('code');
    if (url.searchParams.get('state') !== state || !code) {
      return page(response, 400, '<p>This redirect didn’t come from the setup that agents-factory started.</p>');
    }
    void connection.send({ type: 'setupGitHub', code }).then((reply) => {
      if (!reply.ok) {
        page(response, 502, `<p>${escape(reply.reason)}</p>`);
        print(reply.reason);
        return finish(1);
      }
      const { slug, installationSettings } = reply.value as SetupView;
      // Straight on to choosing the repositories it is installed on.
      response.writeHead(302, { location: installationSettings }).end();
      print(`Created the factory’s GitHub App, ${slug}. Install it on your repositories: ${installationSettings}`);
      finish(0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  print(`Opening ${origin()}/ in your browser to create the factory’s GitHub App, ${name}, on your account…`);
  openUrl(`${origin()}/`);
  signal?.addEventListener('abort', () => {
    print('No App was created: GitHub never redirected back.');
    finish(1);
  });
  const code = await finished;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  return code;
}

// A page that posts the manifest to GitHub at once, with a button in case
// scripts are off.
function formPage(manifest: object, state: string): string {
  return [
    '<p>Sending the factory’s App manifest to GitHub…</p>',
    `<form id="manifest" method="post" action="https://github.com/settings/apps/new?state=${state}">`,
    `<input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">`,
    '<button type="submit">Create the App on GitHub</button>',
    '</form>',
    '<script>document.getElementById("manifest").submit()</script>',
  ].join('\n');
}

function page(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><meta charset="utf-8"><title>agents-factory setup github</title>${body}`);
}

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
