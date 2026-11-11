// The security guidance plugin: a local plugin, `factory-security`, that
// warns an AFK run when an edit writes a known-dangerous pattern
// (`child_process.exec`, raw `innerHTML`, `yaml.load`, hardcoded secrets...),
// so it can fix them before it ends.
//
// Its hook scripts are upstream's `security-guidance` plugin, vendored at a
// pinned revision (see UPSTREAM.md). Only its edit hook is wired, and with
// every review that calls a model turned off: those would spend usage the
// factory doesn't meter, need credentials L2 runs don't have, and can wake a
// run after it ended. The hook needs bash and Python 3 on the run's PATH. On
// a machine without Python it fails without blocking the edit.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The plugin's directory in the package, which L1 runs load as it is.
export const SECURITY_PLUGIN = fileURLToPath(new URL('./plugin', import.meta.url));

// A hash of every file in the plugin, by its path inside it, so an image
// that holds a copy is rebuilt when any of them changes.
export function securityPluginDigest(): string {
  const hash = createHash('sha256');
  const files = readdirSync(SECURITY_PLUGIN, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) hash.update(`${relative(SECURITY_PLUGIN, file).split(sep).join('/')}\0`).update(readFileSync(file)).update('\0');
  return hash.digest('hex').slice(0, 16);
}
