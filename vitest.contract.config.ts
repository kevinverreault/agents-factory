import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.contract.test.{ts,tsx}'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
