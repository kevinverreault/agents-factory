import type { FactoryState } from '../protocol/factory-state.ts';

type Attention = Extract<FactoryState['attentionQueue'][number], { kind: 'attention' }>;

// The Factory recovered report in the attention queue, if any (ADR 0003).
export function recoveryReport(state: FactoryState): Attention | undefined {
  return state.attentionQueue.find((item): item is Attention => item.kind === 'attention' && item.attention === 'recovery-report');
}
