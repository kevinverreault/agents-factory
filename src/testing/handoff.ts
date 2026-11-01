import type { FactoryConnection } from '../protocol/client.ts';
import type { FakeExecutor } from './fake-executor.ts';
import type { Watched } from './watch.ts';

// Hands the HITL task off as the operator does on the handoff sheet: opens
// it, has the task's live run write a brief, and confirms the sheet as it
// was pre-filled.
export async function handOff(operator: FactoryConnection, tui: Watched, executor: FakeExecutor, taskId: string): Promise<void> {
  const opened = await operator.send({ type: 'openHandoff', taskId });
  if (!opened.ok) throw new Error(opened.reason);
  const { liveRunId } = (await tui.until((state) => state.tasks[taskId]?.handoff != null && state.tasks[taskId].liveRunId !== null)).tasks[taskId]!;
  executor.report(liveRunId!, { type: 'briefWritten', brief: { goal: 'Carry the work on.', decided: [], doneWhen: [], outOfScope: [], links: [] } });
  const { brief, continueAs, autonomy, tier, maxTurns } = (await tui.until((state) => !!state.tasks[taskId]?.handoff?.brief)).tasks[taskId]!.handoff!;
  const confirmed = await operator.send({ type: 'handoff', taskId, brief: brief!, continueAs, autonomy, tier, maxTurns });
  if (!confirmed.ok) throw new Error(confirmed.reason);
}
