import { describeSecretsContract } from '../secrets/secrets-contract.ts';
import { FakeSecrets } from './fake-secrets.ts';

describeSecretsContract('the fake secrets', async () => ({ secrets: new FakeSecrets(), async dispose() {} }));
