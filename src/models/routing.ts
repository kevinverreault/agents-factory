// Model routing (ADR 0009): a model tier resolves to one exact model ID from
// the routing table, so a model never changes under a task by surprise.
export const TIERS = ['opus', 'sonnet', 'haiku'] as const;
export type Tier = (typeof TIERS)[number];

// The global default, under the operator's tier and the stage's.
export const DEFAULT_TIER: Tier = 'sonnet';

export type RoutingTable = Record<Tier, string>;
export type Route = { provider: 'claude'; model: string };
// The routing table runs are routed through, or why it can't be read.
export type Routes = RoutingTable | { unreadable: string };

// The routes this factory version ships: a new routing table starts as them,
// and `models update` moves an existing one to them.
export const SHIPPED_ROUTES: RoutingTable = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

export function route(table: RoutingTable, tier: Tier): Route {
  return { provider: 'claude', model: table[tier] };
}

export function isTier(tier: unknown): tier is Tier {
  return (TIERS as readonly unknown[]).includes(tier);
}
