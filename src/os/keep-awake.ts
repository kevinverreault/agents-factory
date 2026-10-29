import { startPowerShellHelper } from './powershell-helper.ts';

export type AwakeBlock = { pid: number; release(): void };

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED: idle sleep is blocked until the holding
// thread clears it or its process exits. The display may still sleep.
const script = `
Add-Type -Namespace Factory -Name Power -MemberDefinition '
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
if ([Factory.Power]::SetThreadExecutionState([uint32]2147483649) -eq 0) { 'failed'; exit 1 }
'ready'
while ($null -ne [Console]::In.ReadLine()) {}
`;

// Holds an idle-sleep block while any AFK run is active (ADR 0003).
export async function holdAwake(): Promise<AwakeBlock> {
  const helper = await startPowerShellHelper(script);
  return { pid: helper.pid, release: () => helper.stop() };
}
