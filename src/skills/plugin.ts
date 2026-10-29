import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Skill = { name: string; description: string; body: string };

// Writes a skill set as the local plugin `factory`, so runs invoke its skills
// as `/factory:<skill>` and no personal or project copy can shadow them
// (ADR 0005). Returns the plugin directory.
export function buildPlugin(dir: string, skills: Skill[]): string {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'factory' }, null, 2));
  for (const skill of skills) {
    mkdirSync(join(dir, 'skills', skill.name), { recursive: true });
    writeFileSync(
      join(dir, 'skills', skill.name, 'SKILL.md'),
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`,
    );
  }
  return dir;
}
