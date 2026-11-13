import { defineConfig } from 'vitest/config';

// Contract tests (Seam 3) drive real adapters on the operator's machine:
// they are slow, spend usage, and some open windows. They run only through
// `npm run test:contract`, never in the default run.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/**/*.contract.test.{ts,tsx}'],
    // Times show in the machine's own zone: tests pin it, so they can name them.
    // NO_COLOR, which an agent's shell may set, is cleared: the tests that
    // want it stub it themselves.
    env: { TZ: 'UTC', NO_COLOR: '' },
  },
});
