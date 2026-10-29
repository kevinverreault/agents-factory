import { startPowerShellHelper } from './powershell-helper.ts';

export type KillOnCloseJob = {
  // The helper process that holds the job. When it dies, so does the job.
  pid: number;
  // Puts a process, and everything it starts from then on, into the job.
  assign(pid: number): Promise<void>;
};

// One job with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and no breakaway allowed.
// Processes already in libuv's job are nested into it (Windows 8+).
const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FactoryJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic BasicLimits; public ulong R, W, O, RB, WB, OB;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  const int ExtendedLimitInformation = 9;
  const uint KillOnJobClose = 0x2000;
  const uint ProcessSetQuotaAndTerminate = 0x0100 | 0x0001;
  static IntPtr job;
  public static int Open() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return Marshal.GetLastWin32Error();
    var info = new Extended();
    info.BasicLimits.LimitFlags = KillOnJobClose;
    return SetInformationJobObject(job, ExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(info)) ? 0 : Marshal.GetLastWin32Error();
  }
  public static int Assign(uint pid) {
    var process = OpenProcess(ProcessSetQuotaAndTerminate, false, pid);
    if (process == IntPtr.Zero) return Marshal.GetLastWin32Error();
    try { return AssignProcessToJobObject(job, process) ? 0 : Marshal.GetLastWin32Error(); }
    finally { CloseHandle(process); }
  }
}
'@
$failure = [FactoryJob]::Open()
if ($failure -ne 0) { "failed $failure"; exit 1 }
'ready'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $failure = [FactoryJob]::Assign([uint32]$line)
  if ($failure -eq 0) { 'ok' } else { "error $failure" }
}
`;

// The best-effort half of run cleanup (ADR 0003): if the daemon crashes, its
// non-detached helper dies with it and the job takes every run's tree down.
// The descendant sweep stays the guarantee.
export async function openKillOnCloseJob(): Promise<KillOnCloseJob> {
  const helper = await startPowerShellHelper(script);
  return {
    pid: helper.pid,
    async assign(pid) {
      const reply = await helper.request(String(pid));
      if (reply !== 'ok') throw new Error(`could not assign process ${pid} to the job: ${reply}`);
    },
  };
}
