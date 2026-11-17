// What the contract tests share: the operator's stored factory App, and a
// shell in a real container.
import { GITHUB_APP_SECRET } from '../daemon/daemon.ts';
import { factoryPaths } from '../daemon/paths.ts';
import type { FactoryApp } from '../github/github.ts';
import type { Container } from '../sandbox/sandbox.ts';
import { windowsCredentials } from '../secrets/secrets.ts';

// The factory identity's App from the operator's own factory home, as `setup github` wrote it.
export async function storedApp(): Promise<FactoryApp> {
  const { AGENTS_FACTORY_HOME, ...env } = process.env;
  const stored = await windowsCredentials(factoryPaths(env).credentialPrefix).read(GITHUB_APP_SECRET);
  if (!stored) throw new Error('No factory App is stored: run `agents-factory setup github` first.');
  return JSON.parse(stored) as FactoryApp;
}

// Runs `script` with `sh` in the container, with exactly `env` set besides the
// image's own, and gives its exit code and output.
export function sh(container: Container, script: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done, fail) => {
    const child = container.spawn('sh', ['-c', script], { env });
    let stdout = '';
    child.stdout!.on('data', (chunk) => (stdout += chunk));
    child.stdin!.end();
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout }));
  });
}
