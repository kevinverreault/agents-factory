import type { TestFactory } from './test-factory.ts';
import type { Watched } from './watch.ts';

// Works the contained AFK root `taskId` through its PR, as its runs' agents
// would: its implement run commits a change in its container, its review
// finds nothing, and its PR body run writes the body. Resolves with its PR's
// number once the factory opened it, In review or at its merge gate.
export async function throughPr({ factory, tui }: { factory: TestFactory; tui: Watched }, taskId: string): Promise<number> {
  let run = (await tui.until((state) => !!state.tasks[taskId]?.liveRunId)).tasks[taskId]!.liveRunId!;
  const workdir = factory.sandbox.workdirOf(taskId);
  factory.git.editFile(workdir, `src/${taskId}.ts`);
  factory.git.commitAll(workdir);
  factory.executor.report(run, { type: 'runCompleted' });
  const next = async (after: string) => (await tui.until((state) => !!state.tasks[taskId]?.liveRunId && state.tasks[taskId].liveRunId !== after)).tasks[taskId]!.liveRunId!;
  // The review finds nothing.
  run = await next(run);
  factory.executor.report(run, { type: 'runCompleted' });
  run = await next(run);
  factory.executor.report(run, { type: 'prBodyWritten', body: `The work of ${taskId}.` });
  factory.executor.report(run, { type: 'runCompleted' });
  const state = await tui.until((state) => state.tasks[taskId]?.state === 'in-review' && !!state.tasks[taskId].pr);
  return state.tasks[taskId]!.pr!.number;
}
