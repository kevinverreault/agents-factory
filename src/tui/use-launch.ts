// A launch from the TUI, while the daemon names and launches the task: one
// at a time, shown with a turning spinner, and still answered if the
// operator left the screen meanwhile. The launch card and quick launch use it.
import { useRef, type ReactNode } from 'react';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { useInFlight } from './in-flight.ts';

// What a launch shows until the daemon answers it: it names the task meanwhile.
export const LAUNCHING = 'Naming the task…';

// How a launch ended: the task it launched, or why it was refused. `left`
// says the operator left the screen before it did.
export type Launched = ({ ok: true; taskId: string } | { ok: false; reason: string }) & { left: boolean };

export type Launch = {
  // Sends `command` unless a launch is under way, then calls `done` with how it ended.
  launch(command: LaunchCommand, done: (launched: Launched) => void): void;
  // Whether a launch is under way: read when keys arrive, before a re-render.
  busy(): boolean;
  // The operator left the screen: a launch under way still ends, but draws nothing.
  leave(): void;
  // The spinner while a launch is under way, else nothing.
  indicator: ReactNode;
};

export function useLaunch(connection: FactoryConnection): Launch {
  const inFlight = useInFlight(connection);
  const left = useRef(false);
  return {
    launch(command, done) {
      void inFlight.send(LAUNCHING, command)?.then((reply) =>
        done({ ...(reply.ok ? { ok: true, taskId: (reply.value as { taskId: string }).taskId } : { ok: false, reason: reply.reason }), left: left.current }),
      );
    },
    busy: () => inFlight.under() !== null,
    leave: () => void (left.current = true),
    indicator: inFlight.indicator,
  };
}
