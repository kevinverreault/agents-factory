// The Secrets port's contract, shared by the fake and the Windows adapter so
// the two can't drift apart.
import { describe, expect, test } from 'vitest';
import type { Secrets } from './secrets.ts';

export type SecretsFixture = {
  secrets: Secrets;
  dispose(): Promise<void>;
};

// A PEM-sized secret with the characters a private key has.
const KEY = `-----BEGIN RSA PRIVATE KEY-----\n${'MIIEowIBAAKCAQEAx+/='.repeat(80)}\n-----END RSA PRIVATE KEY-----\n`;

export function describeSecretsContract(name: string, makeFixture: () => Promise<SecretsFixture>): void {
  async function withFixture(body: (fixture: SecretsFixture) => Promise<void>): Promise<void> {
    const fixture = await makeFixture();
    try {
      await body(fixture);
    } finally {
      await fixture.dispose();
    }
  }

  describe(`${name}: the Secrets contract`, () => {
    test('a secret written is read back as it was, and a secret never written reads as none', () =>
      withFixture(async ({ secrets }) => {
        expect(await secrets.read('github-app')).toBeNull();

        await secrets.write('github-app', KEY);

        expect(await secrets.read('github-app')).toBe(KEY);
        expect(await secrets.read('setup-token')).toBeNull();
      }));

    test('writing again replaces the secret, and removing it leaves none', () =>
      withFixture(async ({ secrets }) => {
        await secrets.write('github-app', 'first');
        await secrets.write('github-app', 'second ✓');
        expect(await secrets.read('github-app')).toBe('second ✓');

        await secrets.remove('github-app');
        await secrets.remove('github-app');

        expect(await secrets.read('github-app')).toBeNull();
      }));
  });
}
