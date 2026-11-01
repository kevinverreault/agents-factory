import type { Secrets } from '../secrets/secrets.ts';

// A credential store that exists only in memory: a test reads what the
// daemon stored there.
export class FakeSecrets implements Secrets {
  readonly stored = new Map<string, string>();

  async read(name: string): Promise<string | null> {
    return this.stored.get(name) ?? null;
  }

  async write(name: string, value: string): Promise<void> {
    this.stored.set(name, value);
  }

  async remove(name: string): Promise<void> {
    this.stored.delete(name);
  }
}
