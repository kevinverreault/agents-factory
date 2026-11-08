import { startPowerShellHelper } from './powershell-helper.ts';

export type KillOnCloseJobs = {
  // The helper process that holds the jobs. When it dies, so does every job.
  pid: number;
  // Puts a process, and everything it starts from then on, into the job
  // named `job`, opened on first use.
  assign(job: string, pid: number): Promise<void>;
  // Kills every process in the job named `job`, if there is one, and closes it.
  close(job: string): Promise<void>;
};

// Jobs with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and no breakaway allowed, by
// name. Processes already in libuv's job are nested into them (Windows 8+).
const script = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FactoryJobs {
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
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  const int ExtendedLimitInformation = 9;
  const uint KillOnJobClose = 0x2000;
  const uint ProcessSetQuotaAndTerminate = 0x0100 | 0x0001;
  static readonly Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();
  public static int Assign(string name, uint pid) {
    IntPtr job;
    if (!jobs.TryGetValue(name, out job)) {
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) return Marshal.GetLastWin32Error();
      var info = new Extended();
      info.BasicLimits.LimitFlags = KillOnJobClose;
      if (!SetInformationJobObject(job, ExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(info))) {
        var failure = Marshal.GetLastWin32Error();
        CloseHandle(job);
        return failure;
      }
      jobs[name] = job;
    }
    var process = OpenProcess(ProcessSetQuotaAndTerminate, false, pid);
    if (process == IntPtr.Zero) return Marshal.GetLastWin32Error();
    try { return AssignProcessToJobObject(job, process) ? 0 : Marshal.GetLastWin32Error(); }
    finally { CloseHandle(process); }
  }
  public static int Close(string name) {
    IntPtr job;
    if (!jobs.TryGetValue(name, out job)) return 0;
    jobs.Remove(name);
    var failure = TerminateJobObject(job, 1) ? 0 : Marshal.GetLastWin32Error();
    CloseHandle(job);
    return failure;
  }
}
'@
'ready'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $verb, $name, $target = $line -split ' '
  $failure = if ($verb -eq 'assign') { [FactoryJobs]::Assign($name, [uint32]$target) } else { [FactoryJobs]::Close($name) }
  if ($failure -eq 0) { 'ok' } else { "error $failure" }
}
`;

// One kill-on-close job per run (ADR 0003). Closing a run's job at its end
// kills what it started, through a shell too, which a walk by parent PID
// can't reach once the shell is gone. If the daemon crashes, its
// non-detached helper dies with it and every job takes its run's tree down.
// The descendant sweep stays the guarantee.
export async function openKillOnCloseJobs(): Promise<KillOnCloseJobs> {
  const helper = await startPowerShellHelper(script);
  // The helper reads one request per line, its words split on spaces.
  const ask = async (verb: 'assign' | 'close', job: string, pid = 0) => {
    if (!/^[\w-]+$/.test(job)) throw new Error(`A job's name is letters, digits, _ and - alone: ${JSON.stringify(job)}.`);
    const line = `${verb} ${job} ${Math.trunc(pid)}`;
    const reply = await helper.request(line);
    if (reply !== 'ok') throw new Error(`The job helper refused \`${line}\`: ${reply}`);
  };
  return {
    pid: helper.pid,
    assign: (job, pid) => ask('assign', job, pid),
    close: (job) => ask('close', job),
  };
}
