// Opens a URL in the operator's default browser, detached, without a shell:
// `cmd /c start` would read the `&` of a query string as a command separator.
import { spawn } from 'node:child_process';

export function openUrl(url: string): void {
  const [command, ...args] =
    process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url] : [process.platform === 'darwin' ? 'open' : 'xdg-open', url];
  spawn(command!, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
