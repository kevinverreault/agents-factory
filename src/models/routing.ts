// Model routing (ADR 0009): a model tier resolves to one exact model ID from
// the routing table, so a model never changes under a task by surprise. The
// factory ships these defaults; `~/.agent-factory/models.yaml` and
// `models update` arrive with their own slice.
export const TIERS = ['opus', 'sonnet', 'haiku'] as const;
export type Tier = (typeof TIERS)[number];

export const DEFAULT_TIER: Tier = 'sonnet';

const DEFAULT_ROUTES: Record<Tier, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

export function route(tier: Tier): { provider: 'claude'; model: string } {
  return { provider: 'claude', model: DEFAULT_ROUTES[tier] };
}
