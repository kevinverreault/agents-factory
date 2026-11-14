// Pure module: whether L3 is refused on a repository as its App was last
// checked (ADR 0014), and with which link.
import { describe, expect, test } from 'vitest';
import { l3Refusal, l3RefusalText, type AppCheck } from './lifecycle.ts';

const settingsUrl = 'https://github.com/settings/installations/7';
const installed = (permissions: object): AppCheck => ({ installed: true, checkedAt: 1, permissions, settingsUrl });

describe('the L3 refusal', () => {
  test('is none where the installation grants Checks and Statuses read, or the App is unchecked', () => {
    expect(l3Refusal('acme/widgets', installed({ checks: 'read', statuses: 'read' }))).toBeNull();
    expect(l3Refusal('acme/widgets', null)).toBeNull();
  });

  test('names what the installation lacks, with its settings page to approve them', () => {
    expect(l3Refusal('acme/widgets', installed({ checks: 'read' }))).toEqual({
      reason: expect.stringContaining('needs Statuses read on acme/widgets'),
      fixUrl: settingsUrl,
    });
    expect(l3RefusalText('acme/widgets', installed({}))).toMatch(new RegExp(`needs Checks read and Statuses read .* Approve them at ${settingsUrl}, then try again\\.$`));
  });

  test('a check stored before the App asked for them recorded no permissions, so it counts as unchecked', () => {
    const stale = { installed: true, checkedAt: 1 } as unknown as AppCheck;

    expect(l3Refusal('acme/widgets', stale)).toBeNull();
  });

  test('where the App isn’t installed, says so with the link to install it', () => {
    const missing: AppCheck = { installed: false, checkedAt: 1, reason: 'It isn’t installed.', fixUrl: 'https://github.com/apps/x/installations/new' };

    expect(l3RefusalText('acme/widgets', missing)).toBe(
      'L3 works as the factory’s App on acme/widgets. It isn’t installed. Install it from https://github.com/apps/x/installations/new, then try again.',
    );
  });
});
