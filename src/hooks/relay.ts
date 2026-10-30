// The `hook` CLI's work (ADR 0002): Claude Code runs it after each tool call
// of a run, with the hook event as JSON on stdin, and it relays the event to
// the daemon over the pipe. A hook must never get in the run's way, so it
// fails silently: no daemon, a refusal or bad input all end it quietly.
import { connect, type Endpoint } from '../protocol/client.ts';
import type { HookEvent } from '../protocol/protocol.ts';

export async function relayHook(input: string, endpoint: Endpoint): Promise<void> {
  let event: HookEvent;
  try {
    event = JSON.parse(input);
  } catch {
    return;
  }
  if (event?.hook_event_name !== 'PostToolUse') return;
  try {
    const connection = await connect(endpoint);
    await connection.send({ type: 'hookEvent', event });
    connection.close();
  } catch {
    // No daemon is listening, or it refused the handshake.
  }
}
