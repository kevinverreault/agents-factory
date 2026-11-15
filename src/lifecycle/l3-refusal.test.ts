// Pure module: whether L3 is refused on a repository as its App was last
// checked (ADR 0014), and with which link.
import { describe, expect, test } from 'vitest';
import { appRefusal, appRefusalText, type AppCheck } from './lifecycle.ts';

const settingsUrl = 'https://github.com/settings/installations/7';
const installed = (permissions: object): AppCheck => ({ installed: true, checkedAt: 1, permissions, settingsUrl });

describe('the L3 refusal', () => {
  test('is none where the installation grants Checks and Statuses read, or the App is unchecked', () => {
    expect(appRefusal('acme/widgets', installed({ checks: 'read', statuses: 'read' }), 'operator')).toBeNull();
    expect(appRefusal('acme/widgets', null, 'operator')).toBeNull();
  });

  test('names what the installation lacks, with its settings page to approve them', () => {
    expect(appRefusal('acme/widgets', installed({ checks: 'read' }), 'operator')).toEqual({
      reason: expect.stringContaining('needs Statuses read on acme/widgets'),
      fixUrl: settingsUrl,
    });
    expect(appRefusalText('acme/widgets', installed({}), 'operator')).toMatch(new RegExp(`needs Checks read and Statuses read .* Approve them at ${settingsUrl}, then try again\\.$`));
  });

  test('a check stored before the App asked for them recorded no permissions, so it counts as unchecked', () => {
    const stale = { installed: true, checkedAt: 1 } as unknown as AppCheck;

    expect(appRefusal('acme/widgets', stale, 'operator')).toBeNull();
  });

  test('where the App isn’t installed, says so with the link to install it', () => {
    const missing: AppCheck = { installed: false, checkedAt: 1, reason: 'It isn’t installed.', fixUrl: 'https://github.com/apps/x/installations/new' };

    expect(appRefusalText('acme/widgets', missing, 'operator')).toBe(
      'L3 works as the factory’s App on acme/widgets. It isn’t installed. Install it from https://github.com/apps/x/installations/new, then try again.',
    );
  });

  test('under full-auto, also asks for Workflows write, which no other policy needs', () => {
    const l3 = installed({ checks: 'read', statuses: 'read' });

    expect(appRefusal('acme/widgets', l3, 'unattended')).toEqual({
      reason: expect.stringContaining('Full-auto pushes and merges changes to workflow files, so the factory’s GitHub App needs Workflows write on acme/widgets'),
      fixUrl: settingsUrl,
    });
    expect(appRefusalText('acme/widgets', installed({ checks: 'read', statuses: 'read', workflows: 'read' }), 'unattended')).toMatch(
      new RegExp(`Workflows write .* or pick semi-auto or the operator policy\\. Approve them at ${settingsUrl}, then try again\\.$`),
    );
    expect(appRefusal('acme/widgets', l3, 'judged')).toBeNull();
    expect(appRefusal('acme/widgets', l3, 'operator')).toBeNull();
    expect(appRefusal('acme/widgets', installed({ checks: 'read', statuses: 'read', workflows: 'write' }), 'unattended')).toBeNull();
  });

  test('under full-auto, one refusal names everything the installation lacks', () => {
    expect(appRefusalText('acme/widgets', installed({ statuses: 'read' }), 'unattended')).toBe(
      'L3 merges a PR only once its checks pass, and full-auto pushes and merges changes to workflow files, so the factory’s GitHub App needs ' +
        'Checks read and Workflows write on acme/widgets, which its installation doesn’t grant yet. Approve the App’s new permissions on GitHub, or pick L2. ' +
        `Approve them at ${settingsUrl}, then try again.`,
    );
  });
});
