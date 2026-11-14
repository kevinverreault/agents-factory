// A command the daemon takes a while to answer, such as opening a handoff:
// one at a time, shown with a turning spinner and a label until the reply,
// so the screen never looks stuck. A key pressed again meanwhile sends nothing more.
import { createElement as h, useReducer, useRef, type ReactNode } from 'react';
import type { FactoryConnection } from '../protocol/client.ts';
import type { Command, Reply } from '../protocol/protocol.ts';
import { Spinner } from './theme.ts';

export type InFlight = {
  // Sends `command`, shown as `label` until its reply, unless a command is
  // already under way: then it sends nothing and returns null.
  send(label: string, command: Command): Promise<Reply> | null;
  // The label of the command under way, or null: read when keys arrive, before a re-render.
  under(): string | null;
  // The spinner while a command is under way, else nothing.
  indicator: ReactNode;
};

export function useInFlight(connection: FactoryConnection): InFlight {
  const under = useRef<string | null>(null);
  const [, rerender] = useReducer((renders: number) => renders + 1, 0);
  return {
    send(label, command) {
      if (under.current !== null) return null;
      under.current = label;
      rerender();
      return connection.send(command).finally(() => {
        under.current = null;
        rerender();
      });
    },
    under: () => under.current,
    indicator: under.current === null ? null : h(Spinner, { label: under.current }),
  };
}
