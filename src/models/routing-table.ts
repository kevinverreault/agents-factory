// The routing table (ADR 0009): `~/.agent-factory/models.yaml`, the operator's
// map from each model tier to an exact model ID. It is seeded with the routes
// the factory ships the first time it is read, so a newer factory shipping
// other routes never moves a tier: only `models update` does.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from 'yaml';
import { isTier, SHIPPED_ROUTES, TIERS, type RoutingTable, type Tier } from './routing.ts';

export interface RoutingTableFile {
  // The table as the file has it, seeded with the shipped routes when there
  // is none. Throws a RoutingTableError when the file can't be read.
  current(): RoutingTable;
  // What `models update` would change: each tier whose route moves to the
  // shipped one. An unreadable table has every tier change, from nothing.
  planUpdate(): RoutingTableUpdate;
  // Moves every tier to the routes the update planned.
  update(update: RoutingTableUpdate): void;
}

export type RoutingTableUpdate = {
  // Why the table couldn't be read, if it couldn't.
  unreadable: string | null;
  changes: { tier: Tier; from: string | null; to: string }[];
  to: RoutingTable;
};

export class RoutingTableError extends Error {}

export function routingTable(path: string, shipped: RoutingTable = SHIPPED_ROUTES): RoutingTableFile {
  function current(): RoutingTable {
    if (!existsSync(path)) write(shipped);
    return read();
  }

  function planUpdate(): RoutingTableUpdate {
    let from: RoutingTable | null = null;
    let unreadable: string | null = null;
    try {
      from = current();
    } catch (error) {
      if (!(error instanceof RoutingTableError)) throw error;
      unreadable = error.message;
    }
    const changes = TIERS.filter((tier) => from?.[tier] !== shipped[tier]).map((tier) => ({ tier, from: from?.[tier] ?? null, to: shipped[tier] }));
    return { unreadable, changes, to: { ...shipped } };
  }

  function read(): RoutingTable {
    const unreadable = (why: string) => new RoutingTableError(`The routing table at ${path} can’t be read: ${why}`);
    let raw: unknown;
    try {
      raw = parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw unreadable((error as Error).message);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw unreadable('it isn’t a map of tiers to models.');
    const table = raw as Record<string, unknown>;
    const stray = Object.keys(table).find((key) => !isTier(key));
    if (stray) throw unreadable(`${stray} is not a model tier.`);
    for (const tier of TIERS) {
      const model = table[tier];
      if (model === undefined) throw unreadable(`it routes no model for ${tier}.`);
      // An alias such as `opus` would move under a task with no explicit step.
      if (typeof model !== 'string' || !/^claude-[a-z0-9.-]+$/.test(model) || model.endsWith('-latest')) {
        throw unreadable(`${tier} routes to ${JSON.stringify(model)}, which is not an exact Claude model ID.`);
      }
    }
    return table as RoutingTable;
  }

  function write(table: RoutingTable): void {
    mkdirSync(dirname(path), { recursive: true });
    const lines = TIERS.map((tier) => `${tier}: ${table[tier]}`);
    writeFileSync(path, ['# Each model tier’s exact model ID. Only `agents-factory models update` moves them.', ...lines, ''].join('\n'));
  }

  return { current, planUpdate, update: ({ to }) => write(to) };
}
