// The user-level routing table file (ADR 0009): tested directly over a temp
// file, with what each factory version ships passed in.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { routingTable } from './routing-table.ts';
import { TIERS } from './routing.ts';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tablePath(): string {
  const home = mkdtempSync(join(tmpdir(), 'factory-models-'));
  homes.push(home);
  return join(home, 'models.yaml');
}

const shipped = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
// What a later factory version ships.
const newer = { opus: 'claude-opus-6', sonnet: 'claude-sonnet-6', haiku: 'claude-haiku-5-5' };

describe('the routing table', () => {
  test('starts as the routes the factory ships, and keeps them when a later factory ships others', () => {
    const path = tablePath();

    expect(routingTable(path, shipped).current()).toEqual(shipped);
    expect(routingTable(path, newer).current()).toEqual(shipped);
  });

  test('an update moves each tier to the routes the factory now ships, listing the ones that change', () => {
    const path = tablePath();
    routingTable(path, shipped).current();
    const table = routingTable(path, newer);

    const update = table.planUpdate();
    expect(update.changes).toEqual([
      { tier: 'opus', from: 'claude-opus-5-5', to: 'claude-opus-6' },
      { tier: 'sonnet', from: 'claude-sonnet-5-5', to: 'claude-sonnet-6' },
    ]);
    expect(table.current()).toEqual(shipped);

    table.update(update);
    expect(table.current()).toEqual(newer);
    expect(table.planUpdate().changes).toEqual([]);
  });

  test('a table that can’t be read routes nothing, and an update replaces it', () => {
    const path = tablePath();
    writeFileSync(path, 'opus: claude-opus-5-5\nsonnet: sonnet\nhaiku: claude-haiku-5-5\n');
    const table = routingTable(path, shipped);

    expect(() => table.current()).toThrow(`The routing table at ${path} can’t be read: sonnet routes to "sonnet", which is not an exact Claude model ID.`);
    const update = table.planUpdate();
    expect(update).toMatchObject({ unreadable: expect.stringContaining('sonnet routes to "sonnet"') });
    expect(update.changes).toEqual(TIERS.map((tier) => ({ tier, from: null, to: shipped[tier] })));

    table.update(update);
    expect(table.current()).toEqual(shipped);
  });

  test('a `-latest` alias is no exact model ID: it would move with no update', () => {
    const path = tablePath();
    writeFileSync(path, 'opus: claude-opus-latest\nsonnet: claude-sonnet-5-5\nhaiku: claude-haiku-5-5\n');

    expect(() => routingTable(path, shipped).current()).toThrow('opus routes to "claude-opus-latest", which is not an exact Claude model ID.');
  });
});
