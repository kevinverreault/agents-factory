// Stands in for a CLI and the tools it starts. Each process records its PID
// under its role, and the CLI waits a moment before starting tools (the daemon
// assigns it to the job right after spawn). The tools take the two routes out
// of libuv's kill-on-close jobs: through a shell (cmd.exe holds no job, and
// libuv's job lets grandchildren break away silently), and `detached`.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const roles = ['cli', 'shell-tool', 'detached-tool'] as const;
type Role = (typeof roles)[number];

function start(pidDir: string, next: Role, options: { shell?: boolean; detached?: boolean }) {
  const args = [fileURLToPath(import.meta.url), pidDir, next];
  const [command, argv] = options.shell
    ? [`"${process.execPath}" ${args.map((arg) => `"${arg}"`).join(' ')}`, []]
    : [process.execPath, args];
  spawn(command, argv, { stdio: 'ignore', windowsHide: true, ...options });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [pidDir, role] = process.argv.slice(2) as [string, Role];
  writeFileSync(join(pidDir, `${role}.pid`), String(process.pid));
  setInterval(() => {}, 60_000);
  if (role === 'cli') {
    setTimeout(() => {
      start(pidDir, 'shell-tool', { shell: true });
      start(pidDir, 'detached-tool', { detached: true });
    }, 1_500);
  }
}
