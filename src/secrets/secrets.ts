// The secrets port (ADR 0004): the OS credential store, which holds the
// factory identity's App private key. Only the daemon calls it, and a secret
// never goes into the store's SQLite file, an env file or a command line.
// The Windows adapter wraps Credential Manager.
import { startPowerShellHelper } from '../os/powershell-helper.ts';

export interface Secrets {
  // The secret stored under `name`, or null when there is none.
  read(name: string): Promise<string | null>;
  write(name: string, value: string): Promise<void>;
  // Removes the secret under `name`, if any.
  remove(name: string): Promise<void>;
}

export class SecretsError extends Error {}

// CRED_MAX_CREDENTIAL_BLOB_SIZE: a generic credential holds at most this many bytes.
const MAX_SECRET_BYTES = 5 * 512;

// The C# half: one JSON request per line on stdin, one JSON reply per line on
// stdout. Values travel base64-encoded, as UTF-8 bytes.
const script = `
Add-Type -Namespace Factory -Name Credentials -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags; public uint Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
  public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
static extern bool CredDelete(string target, uint type, uint flags);
[DllImport("advapi32.dll")]
static extern void CredFree(IntPtr buffer);
const uint GENERIC = 1, PERSIST_LOCAL_MACHINE = 2, NOT_FOUND = 1168;
public static string Read(string target) {
  IntPtr found;
  if (!CredRead(target, GENERIC, 0, out found)) {
    int error = Marshal.GetLastWin32Error();
    if (error == NOT_FOUND) return null;
    throw new System.ComponentModel.Win32Exception(error);
  }
  try {
    CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(found, typeof(CREDENTIAL));
    byte[] blob = new byte[credential.CredentialBlobSize];
    Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
    return Convert.ToBase64String(blob);
  } finally { CredFree(found); }
}
public static void Write(string target, string value) {
  byte[] blob = Convert.FromBase64String(value);
  CREDENTIAL credential = new CREDENTIAL();
  credential.Type = GENERIC; credential.TargetName = target; credential.Persist = PERSIST_LOCAL_MACHINE;
  credential.UserName = "agents-factory"; credential.CredentialBlobSize = (uint)blob.Length;
  credential.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
  try {
    Marshal.Copy(blob, 0, credential.CredentialBlob, blob.Length);
    if (!CredWrite(ref credential, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  } finally {
    Marshal.Copy(new byte[blob.Length], 0, credential.CredentialBlob, blob.Length);
    Marshal.FreeHGlobal(credential.CredentialBlob);
  }
}
public static void Delete(string target) {
  if (CredDelete(target, GENERIC, 0)) return;
  int error = Marshal.GetLastWin32Error();
  if (error != NOT_FOUND) throw new System.ComponentModel.Win32Exception(error);
}
'@
'ready'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    $value = $null
    switch ($request.op) {
      'read' { $value = [Factory.Credentials]::Read($request.target) }
      'write' { [Factory.Credentials]::Write($request.target, $request.value) }
      'remove' { [Factory.Credentials]::Delete($request.target) }
    }
    @{ ok = $true; value = $value } | ConvertTo-Json -Compress
  } catch {
    $cause = $_.Exception
    if ($cause.InnerException) { $cause = $cause.InnerException }
    @{ ok = $false; error = $cause.Message } | ConvertTo-Json -Compress
  }
}
`;

// Generic credentials in Windows Credential Manager, named `<prefix>/<name>`
// and kept for this OS user on this machine only (never roamed).
export function windowsCredentials(prefix: string): Secrets {
  async function call(request: { op: 'read' | 'write' | 'remove'; name: string; value?: string }): Promise<string | null> {
    const helper = await startPowerShellHelper(script);
    try {
      const line = await helper.request(JSON.stringify({ op: request.op, target: `${prefix}/${request.name}`, value: request.value }));
      const reply = JSON.parse(line) as { ok: boolean; value?: string | null; error?: string };
      if (!reply.ok) throw new SecretsError(`Windows Credential Manager refused to ${request.op} ${request.name}: ${reply.error}`);
      return reply.value ?? null;
    } finally {
      helper.stop();
    }
  }
  return {
    async read(name) {
      const value = await call({ op: 'read', name });
      return value === null ? null : Buffer.from(value, 'base64').toString('utf8');
    },
    async write(name, value) {
      const bytes = Buffer.from(value, 'utf8');
      if (bytes.length > MAX_SECRET_BYTES) {
        throw new SecretsError(`The secret ${name} is ${bytes.length} bytes, over the ${MAX_SECRET_BYTES} a Windows credential holds.`);
      }
      await call({ op: 'write', name, value: bytes.toString('base64') });
    },
    async remove(name) {
      await call({ op: 'remove', name });
    },
  };
}
