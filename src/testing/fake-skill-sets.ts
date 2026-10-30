import { resolve } from 'node:path';
import type { SkillSets, BuiltSkillSet } from '../skills/skill-set.ts';

// Skill set versions that exist only in memory: a test moves the pin, as
// `skills update` would, and reads which versions are still built.
export class FakeSkillSets implements SkillSets {
  readonly built = new Set<string>();
  private pinned = 'a1a1a1a1a1a1a1a1';
  private failure: string | null = null;

  // Moves the pin to the skill set whose content hashes to `version`.
  pin(version: string): void {
    this.pinned = version;
  }

  // Building fails with `reason` from now on, as an unreachable upstream would.
  failBuilds(reason: string): void {
    this.failure = reason;
  }

  async current(): Promise<BuiltSkillSet> {
    if (this.failure) throw new Error(this.failure);
    this.built.add(this.pinned);
    return { version: this.pinned, path: this.pathOf(this.pinned) };
  }

  pathOf(version: string): string {
    return resolve('/skill-sets', version);
  }

  async prune(keep: Iterable<string>): Promise<void> {
    const kept = new Set(keep);
    for (const version of this.built) if (!kept.has(version)) this.built.delete(version);
  }
}
