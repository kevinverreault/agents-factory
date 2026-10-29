import { defineConfig } from 'vitest/config';

// Contract tests (Seam 3) drive real adapters on the operator's machine:
// they are slow, spend usage, and some open windows. They run only through
// `npm run test:contract`, never in the default run.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/**/*.contract.test.{ts,tsx}'],
  },
});
