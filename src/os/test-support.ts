// Helpers shared by the Windows contract tests.
import { execFileSync } from 'node:child_process';

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function powershell(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

const ES_SYSTEM_REQUIRED = 0x1;

// True while any process on the machine holds an idle-sleep block. Readable
// without elevation, unlike `powercfg /requests`.
export function systemSleepBlocked(): boolean {
  const state = powershell(`Add-Type -Namespace Win32 -Name PowerState -MemberDefinition '
[DllImport("powrprof.dll")] public static extern uint CallNtPowerInformation(int level, IntPtr inBuf, uint inLen, out uint outBuf, uint outLen);'
$state = [uint32]0
[void][Win32.PowerState]::CallNtPowerInformation(16, [IntPtr]::Zero, 0, [ref]$state, 4)
$state`);
  return (Number(state) & ES_SYSTEM_REQUIRED) !== 0;
}
