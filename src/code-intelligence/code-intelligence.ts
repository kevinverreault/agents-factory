// The code intelligence plugin: a local plugin, `factory-lsp`, that gives
// Claude Code a TypeScript language server. With it, an AFK run sees the type
// errors its edits introduce and gets the read-only `LSP` tool, which finds
// definitions and references by symbol.
//
// The server is the pinned `typescript-language-server`, run by Node from the
// factory's own dependencies, so nothing is installed globally and no `.cmd`
// shim stands between Claude Code and it on Windows. It runs the target
// repo's own `tsserver` when the repo has one, else the factory's pinned
// TypeScript 6. TypeScript 7 serves LSP itself, but it only answers
// diagnostic pulls, and Claude Code waits for diagnostics to be pushed after
// an edit, so a TypeScript 7 repo still gets TypeScript 6's diagnostics.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// How Claude Code starts the TypeScript language server, and the tsserver it
// falls back to when the repo has none.
export type LanguageServer = { command: string; args: string[]; fallbackTsserver: string };

// The versions of the language server and of its fallback TypeScript.
export type LanguageServerVersions = { server: string; typescript: string };

// Every TypeScript and JavaScript extension, by its LSP language id.
const TYPESCRIPT_LANGUAGES = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

// The plugin's manifest, for a language server started as given.
export function lspPluginManifest({ command, args, fallbackTsserver }: LanguageServer) {
  return {
    name: 'factory-lsp',
    description: 'TypeScript and JavaScript code intelligence for factory runs',
    lspServers: {
      typescript: {
        command,
        args,
        extensionToLanguage: TYPESCRIPT_LANGUAGES,
        initializationOptions: { tsserver: { fallbackPath: fallbackTsserver } },
      },
    },
  };
}

// Writes the plugin to `dir` and returns the directory. The manifest is
// replaced whole, so a run starting meanwhile never reads half of it.
export function buildLspPlugin(dir: string, server: LanguageServer): string {
  const manifest = join(dir, '.claude-plugin', 'plugin.json');
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(`${manifest}.tmp`, `${JSON.stringify(lspPluginManifest(server), null, 2)}\n`);
  renameSync(`${manifest}.tmp`, manifest);
  return dir;
}

const require = createRequire(import.meta.url);
const packageDir = (name: string) => dirname(require.resolve(`${name}/package.json`));

// The pinned server on the host. Its command is the `node` on the run's
// PATH, not the daemon's own `process.execPath`: Claude Code refuses a
// command with a space in it, and Node's Windows install path has one.
export function hostTypeScriptServer(): LanguageServer {
  return {
    command: 'node',
    args: [join(packageDir('typescript-language-server'), 'lib', 'cli.mjs'), '--stdio'],
    fallbackTsserver: join(packageDir('typescript-6'), 'lib', 'tsserver.js'),
  };
}

// The pinned versions, which an L2 container installs for itself.
export function pinnedLanguageServerVersions(): LanguageServerVersions {
  const versionOf = (name: string) => (require(`${name}/package.json`) as { version: string }).version;
  return { server: versionOf('typescript-language-server'), typescript: versionOf('typescript-6') };
}
