// Stands in for a TUI: auto-starts the daemon stub, records both PIDs, then
// waits in its terminal window until the window is closed. With `--close`, it
// closes its own console window the way the close button does (WM_CLOSE).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnDetached } from '../spawn-detached.ts';

export function startTuiStub(pidFile: string): void {
  const daemon = spawnDetached(process.execPath, [fileURLToPath(new URL('./daemon-stub.ts', import.meta.url))]);
  writeFileSync(pidFile, JSON.stringify({ tui: process.pid, daemon: daemon.pid }));
  setInterval(() => {}, 60_000);
}

// A child on the same console can find the console window and close it.
function closeOwnConsoleWindow(): void {
  spawn('powershell.exe', ['-NoProfile', '-Command', `Add-Type -Namespace Win32 -Name Console -MemberDefinition '
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);'
[void][Win32.Console]::PostMessage([Win32.Console]::GetConsoleWindow(), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)`], {
    stdio: 'inherit',
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [pidFile, mode] = process.argv.slice(2);
  startTuiStub(pidFile!);
  if (mode === '--close') closeOwnConsoleWindow();
}
