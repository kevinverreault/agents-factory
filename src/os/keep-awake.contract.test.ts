// Seam 3: the keep-awake helper holds an idle-sleep block while it lives
// (ADR 0003).
import { beforeAll, describe, expect, test } from 'vitest';
import { holdAwake } from './keep-awake.ts';
import { systemSleepBlocked, waitFor } from './test-support.ts';

describe('keep-awake helper on Windows', () => {
  beforeAll(() => {
    if (systemSleepBlocked()) throw new Error('Another process already blocks idle sleep; close it and rerun.');
  });

  test('the machine stays awake while the block is held, and may sleep once it is released', async () => {
    const block = await holdAwake();
    expect(systemSleepBlocked()).toBe(true);

    block.release();
    await waitFor(() => !systemSleepBlocked(), 10_000);
  });

  test('the block ends when its holder dies', async () => {
    const block = await holdAwake();
    expect(systemSleepBlocked()).toBe(true);

    process.kill(block.pid);
    await waitFor(() => !systemSleepBlocked(), 10_000);
  });
});
