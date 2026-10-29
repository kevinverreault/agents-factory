// When the OS created a process, in epoch milliseconds. Stored with a run's
// CLI PID, it tells the descendant sweep a reused PID from the CLI (ADR 0003).
import { execFile } from 'node:child_process';

export function processCreatedAt(pid: number): Promise<number> {
  const script = `[DateTimeOffset]::new((Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`;
  return new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (error, stdout) => {
      const createdAt = Number(stdout.trim());
      if (error || !Number.isFinite(createdAt) || createdAt <= 0) reject(error ?? new Error(`No creation time for process ${pid}.`));
      else resolve(createdAt);
    }),
  );
}
