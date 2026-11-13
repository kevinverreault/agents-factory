// Text the operator edits in their own editor: $VISUAL, else $EDITOR, else
// notepad on Windows and vi elsewhere. The caller hands the terminal over
// while it runs (Ink's suspendTerminal).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Edited = { ok: true; text: string } | { ok: false; reason: string };

// The editor to run, as a shell command line: it may carry arguments, as
// `code --wait` does.
export function editorCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return env.VISUAL?.trim() || env.EDITOR?.trim() || (platform === 'win32' ? 'notepad' : 'vi');
}

// `text` after the operator saved it and quit their editor. Editors end
// the file with a line break; one the text didn't have is dropped.
export async function editExternally(text: string, name = 'prompt.md', command = editorCommand()): Promise<Edited> {
  const dir = await mkdtemp(join(tmpdir(), 'agents-factory-'));
  const path = join(dir, name);
  try {
    await writeFile(path, text, 'utf8');
    const exit = await new Promise<{ code: number | null; signal?: NodeJS.Signals | null; error?: Error }>((resolve) => {
      const child = spawn(`${command} ${quoted(path)}`, { shell: true, stdio: 'inherit' });
      child.on('error', (error) => resolve({ code: null, error }));
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    if (exit.error) return { ok: false, reason: `Couldn't run ${command}: ${exit.error.message}` };
    if (exit.code !== 0) {
      const how = exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`;
      return { ok: false, reason: `${command} ${how}: the prompt is unchanged.` };
    }
    // Notepad starts what it saves with a byte order mark.
    const saved = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    return { ok: true, text: !text.endsWith('\n') && saved.endsWith('\n') ? saved.slice(0, -1) : saved };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A path as one word to the shell: cmd takes it in double quotes, which a
// Windows path can't hold; a POSIX shell expands nothing in single quotes.
function quoted(path: string): string {
  return process.platform === 'win32' ? `"${path}"` : `'${path.replaceAll("'", `'\\''`)}'`;
}
