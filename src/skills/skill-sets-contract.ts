// The SkillSets port's contract, shared by the fake and the real manager so
// the two can't drift apart.
import { describe, expect, test } from 'vitest';
import type { SkillSets } from './skill-set.ts';

export type SkillSetsFixture = {
  skillSets: SkillSets;
  // Moves the pin to a skill set with different content, as `skills update` would.
  movePin(): Promise<void>;
  // Whether `version` is still built.
  isBuilt(version: string): boolean;
  dispose(): Promise<void>;
};

export function describeSkillSetsContract(name: string, makeFixture: () => Promise<SkillSetsFixture>): void {
  async function withFixture(body: (fixture: SkillSetsFixture) => Promise<void>): Promise<void> {
    const fixture = await makeFixture();
    try {
      await body(fixture);
    } finally {
      await fixture.dispose();
    }
  }

  describe(`${name}: the SkillSets contract`, () => {
    test('the pinned skill set keeps its version, and lives where its version says, until the pin moves', () =>
      withFixture(async ({ skillSets }) => {
        const first = await skillSets.current();
        const again = await skillSets.current();

        expect(again).toEqual(first);
        expect(first.path).toBe(skillSets.pathOf(first.version));
      }));

    test('moving the pin to other content gives a new version and leaves the old one built', () =>
      withFixture(async ({ skillSets, movePin, isBuilt }) => {
        const before = await skillSets.current();
        await movePin();
        const after = await skillSets.current();

        expect(after.version).not.toBe(before.version);
        expect(isBuilt(before.version)).toBe(true);
        expect(isBuilt(after.version)).toBe(true);
      }));

    test('pruning removes every built version but the ones kept', () =>
      withFixture(async ({ skillSets, movePin, isBuilt }) => {
        const kept = await skillSets.current();
        await movePin();
        const dropped = await skillSets.current();

        await skillSets.prune([kept.version]);

        expect(isBuilt(kept.version)).toBe(true);
        expect(isBuilt(dropped.version)).toBe(false);
      }));
  });
}
