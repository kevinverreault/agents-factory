// `agents-factory models update` (ADR 0009): the one way a tier's model
// moves. It works on the routing table directly: the daemon reads the table
// afresh each time a run starts, so runs started from then on use it.
import { createInterface } from 'node:readline/promises';
import type { FactoryPaths } from '../daemon/paths.ts';
import { routingTable, type RoutingTableUpdate } from './routing-table.ts';
import { TIERS, type Tier } from './routing.ts';

export async function modelsCommand(paths: FactoryPaths): Promise<number> {
  const table = routingTable(paths.modelsTable);
  const update = table.planUpdate();
  console.log(describeUpdate(update));
  if (update.changes.length === 0) return 0;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question('Route these tiers to the new models? Live runs keep theirs. [y/N] ').catch(() => '');
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log('The routing table stays as it is.');
    return 0;
  }
  table.update(update);
  console.log(`Updated ${paths.modelsTable}.`);
  return 0;
}

function describeUpdate({ unreadable, changes, to }: RoutingTableUpdate): string {
  if (changes.length === 0) {
    return ['Every tier already routes to the model this factory ships:', ...TIERS.map((tier) => row(tier, to[tier]))].join('\n');
  }
  return [
    unreadable ? `${unreadable}\nThe update replaces it with:` : 'These tiers move:',
    ...changes.map(({ tier, from, to }) => row(tier, from ? `${from} → ${to}` : to)),
  ].join('\n');
}

const row = (tier: Tier, route: string) => `  ${tier.padEnd(6)}  ${route}`;
