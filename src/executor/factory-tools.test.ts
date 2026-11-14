// The factory tools an AFK run is given, by what it reports (ADR 0014): a
// semi-auto root's judging run gets `report_verdict` and nothing else, not
// even the delegation tools.
import { expect, test } from 'vitest';
import { afkFactoryTools } from './factory-tools.ts';

const sink = { report: () => {}, delegate: async () => ({ ok: true }) } as never;

test('a judging run is given report_verdict alone', () => {
  const { allowed } = afkFactoryTools('R1', sink, ['verdict'], { child: false, spawns: true, assumes: false });
  expect(allowed).toEqual(['mcp__factory__report_verdict']);
});

test('a review run is given report_findings and the delegation tools, and no report_verdict', () => {
  const { allowed } = afkFactoryTools('R1', sink, ['findings'], { child: false, spawns: true, assumes: false });
  expect(allowed).toContain('mcp__factory__report_findings');
  expect(allowed).toContain('mcp__factory__spawn_child');
  expect(allowed).not.toContain('mcp__factory__report_verdict');
});
