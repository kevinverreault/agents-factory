// What the TUI shows instead of attaching to a daemon of another version
// (ADR 0002): 1 restarts it now, 2 once no run is active, q quits. Once this
// build's daemon is up and attached to, `onAttached` gets its connection.
import { createElement as h, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { RestartWhen } from '../daemon/auto-start.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import { PROTOCOL_VERSION } from '../protocol/protocol.ts';
import { Option, Sheet, tone } from './theme.ts';

type Props = {
  daemonVersion: number;
  // Restarts the daemon, telling `onWaiting` how many runs it waits for.
  restart: (when: RestartWhen, onWaiting: (activeRuns: number) => void) => Promise<FactoryConnection>;
  onAttached: (connection: FactoryConnection) => void;
  onQuit: () => void;
};

// Where the restart stands: not chosen yet (with why the last one failed,
// if it did), under way, or waiting on the old daemon's active runs.
type Stage = { kind: 'choosing'; problem: string | null } | { kind: 'restarting' } | { kind: 'waiting'; activeRuns: number };

const CHOICES: [RestartWhen, string][] = [
  ['now', 'Restart now: active AFK runs are requeued, losing their in-flight turn; the rest are parked.'],
  ['idle', 'Restart when idle: the daemon starts no new run, and restarts once no run is active.'],
];

export function RestartPrompt({ daemonVersion, restart, onAttached, onQuit }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'choosing', problem: null });

  useInput((input, key) => {
    if (input === 'q' || key.escape) return onQuit();
    if (stage.kind !== 'choosing') return;
    const when = CHOICES[Number(input) - 1]?.[0];
    if (!when) return;
    setStage({ kind: 'restarting' });
    restart(when, (activeRuns) => setStage({ kind: 'waiting', activeRuns })).then(onAttached, (error: Error) =>
      setStage({ kind: 'choosing', problem: error.message }),
    );
  });

  const skew = `The running daemon speaks protocol ${daemonVersion}, and this agents-factory speaks ${PROTOCOL_VERSION}.`;
  const title = 'Restart the daemon';
  if (stage.kind === 'restarting') return h(Sheet, { title }, h(Text, null, 'Restarting the daemon…'));
  if (stage.kind === 'waiting') {
    const runs = stage.activeRuns === 1 ? 'its active run ends' : `its ${stage.activeRuns} active runs end`;
    return h(Sheet, { title, hint: 'q quit' }, h(Text, null, `The daemon restarts once ${runs}. You can close this and come back.`));
  }
  return h(
    Sheet,
    { title, role: 'warn', hint: 'q quit' },
    h(Text, null, skew),
    stage.problem ? h(Text, tone('warn'), stage.problem) : null,
    ...CHOICES.map(([when, label], i) => h(Option, { key: when, digit: i + 1 }, label)),
  );
}
