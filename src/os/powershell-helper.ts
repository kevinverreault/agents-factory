import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Helper = {
  pid: number;
  // Sends one request line and resolves with the helper's reply line.
  request(line: string): Promise<string>;
  // Closes the helper's stdin; the helper exits when it reads end of input.
  stop(): void;
};

// Starts a long-lived PowerShell helper as a non-detached child, so it dies with
// its parent. The script answers each stdin line with one stdout line, and
// prints `ready` once set up.
export function startPowerShellHelper(script: string): Promise<Helper> {
  // The script travels on the command line so that stdin carries only requests.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child: ChildProcessWithoutNullStreams = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true },
  );
  const replies = createInterface({ input: child.stdout });
  const waiting: ((line: string) => void)[] = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));

  return new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`PowerShell helper exited (${code}): ${stderr}`)));
    replies.once('line', (first) => {
      if (first !== 'ready') return reject(new Error(`PowerShell helper failed: ${first} ${stderr}`));
      replies.on('line', (line) => waiting.shift()?.(line));
      resolve({
        pid: child.pid!,
        request(line) {
          return new Promise((answer) => {
            waiting.push(answer);
            child.stdin.write(`${line}\n`);
          });
        },
        stop() {
          child.stdin.end();
        },
      });
    });
  });
}
