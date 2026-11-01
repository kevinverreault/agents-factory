// Seam 3: the secrets port on the real Windows Credential Manager, under a
// throwaway prefix that the fixture clears afterwards.
import { randomBytes } from 'node:crypto';
import { describeSecretsContract } from './secrets-contract.ts';
import { windowsCredentials } from './secrets.ts';

describeSecretsContract('Windows Credential Manager', async () => {
  const secrets = windowsCredentials(`agents-factory-contract-${randomBytes(4).toString('hex')}`);
  return {
    secrets,
    async dispose() {
      for (const name of ['github-app', 'setup-token']) await secrets.remove(name);
    },
  };
});
