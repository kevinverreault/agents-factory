// Seam 2: what the TUI shows instead of attaching to a daemon of another
// version (ADR 0002): restart now, or restart when idle.
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RestartWhen } from '../daemon/auto-start.ts';
import { PROTOCOL_VERSION } from '../protocol/protocol.ts';
import { FakeConnection } from '../testing/fake-connection.ts';
import { RestartPrompt } from './restart-prompt.ts';

const apps: { unmount(): void }[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 2_000, interval: 10 });
const flat = (frame: string | undefined) => (frame ?? '').replace(/\s+/g, ' ');

function prompted() {
  const asked: RestartWhen[] = [];
  let finish!: (connection: FakeConnection) => void;
  let fail!: (error: Error) => void;
  let waiting!: (activeRuns: number) => void;
  const restart = (when: RestartWhen, onWaiting: (activeRuns: number) => void) => {
    asked.push(when);
    waiting = onWaiting;
    return new Promise<FakeConnection>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  };
  const attached: FakeConnection[] = [];
  let quit = 0;
  const app = render(<RestartPrompt daemonVersion={3} restart={restart} onAttached={(c) => attached.push(c as FakeConnection)} onQuit={() => quit++} />);
  apps.push(app);
  return { app, asked, attached, quits: () => quit, finish: (c: FakeConnection) => finish(c), fail: (e: Error) => fail(e), waiting: (n: number) => waiting(n) };
}

describe('a daemon of another version', () => {
  test('offers restart now and restart when idle, saying what each does', async () => {
    const { app } = prompted();

    await eventually(() => {
      const frame = flat(app.lastFrame());
      expect(frame).toContain(`The running daemon speaks protocol 3, and this agents-factory speaks ${PROTOCOL_VERSION}.`);
      expect(frame).toContain('1 Restart now: active AFK runs are requeued, losing their in-flight turn; the rest are parked.');
      expect(frame).toContain('2 Restart when idle: the daemon starts no new run, and restarts once no run is active.');
      expect(frame).toContain('q quit');
    });
  });

  test('1 restarts now and attaches to the new daemon', async () => {
    const { app, asked, attached, finish } = prompted();

    app.stdin.write('1');
    await eventually(() => expect(asked).toEqual(['now']));
    await eventually(() => expect(flat(app.lastFrame())).toContain('Restarting the daemon…'));
    const connection = new FakeConnection();
    finish(connection);

    await eventually(() => expect(attached).toEqual([connection]));
  });

  test('2 restarts when idle, showing how many runs it waits for', async () => {
    const { app, asked, waiting, attached, finish } = prompted();

    app.stdin.write('2');
    await eventually(() => expect(asked).toEqual(['idle']));
    waiting(2);
    await eventually(() => expect(flat(app.lastFrame())).toContain('The daemon restarts once its 2 active runs end. You can close this and come back.'));
    expect(attached).toEqual([]);
    const connection = new FakeConnection();
    finish(connection);

    await eventually(() => expect(attached).toEqual([connection]));
  });

  test('a restart that fails says why, and the choices stay on offer', async () => {
    const { app, asked, fail } = prompted();
    app.stdin.write('2');
    await eventually(() => expect(asked).toEqual(['idle']));

    fail(new Error('The running daemon is too old to restart when idle.'));

    await eventually(() => expect(flat(app.lastFrame())).toContain('The running daemon is too old to restart when idle. 1 Restart now'));
    app.stdin.write('1');
    await eventually(() => expect(asked).toEqual(['idle', 'now']));
  });

  test('q quits without restarting anything', async () => {
    const { app, asked, quits } = prompted();
    await settle();

    app.stdin.write('q');

    await eventually(() => expect(quits()).toBe(1));
    expect(asked).toEqual([]);
  });
});
