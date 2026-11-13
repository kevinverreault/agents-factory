// The Ralph loop (ADR 0006) until it is retired: built-in main-flow's
// implement stage launches ticket tasks now (ADR 0013), so the tests of the
// loop run main-flow, and implement extending it, with its old loop stage,
// written as the operator's own main-flow.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestFactory } from './test-factory.ts';

const RALPH_LOOP_MAIN_FLOW = ['extends: main-flow', 'stages:', '  - id: implement', '    kind: loop', '    exit: tickets-closed', ''].join('\n');

export function keepRalphLoop(factory: TestFactory): void {
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(join(factory.paths.presetsDir, 'main-flow.preset.yaml'), RALPH_LOOP_MAIN_FLOW);
}
