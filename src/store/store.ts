// The store seam (ADR 0002): one SQLite file in per-user app data, WAL on,
// opened only by the daemon. The schema is private to this module.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Lifecycle } from '../lifecycle/lifecycle.ts';

export interface Store {
  // The Lifecycle as last saved, or null for a new store.
  loadLifecycle(): Lifecycle | null;
  saveLifecycle(lifecycle: Lifecycle): void;
  close(): void;
}

const COLLECTIONS = { tasks: 'tasks', runs: 'runs', requests: 'attention_requests' } as const;
type Collection = keyof typeof COLLECTIONS;

export function openStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attention_requests (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL);
  `);

  // What each row held when last written, so a save writes only changed rows.
  const written = new Map<string, string>();

  function load(): Lifecycle | null {
    const meta = db.prepare(`SELECT value FROM meta WHERE key = 'lifecycle'`).get() as { value: string } | undefined;
    if (!meta) return null;
    const { counters, slotCap } = JSON.parse(meta.value) as Pick<Lifecycle, 'counters' | 'slotCap'>;
    const lifecycle: Lifecycle = { counters, slotCap, tasks: {}, runs: {}, requests: {} };
    for (const collection of Object.keys(COLLECTIONS) as Collection[]) {
      const rows = db.prepare(`SELECT id, data FROM ${COLLECTIONS[collection]} ORDER BY seq`).all() as {
        id: string;
        data: string;
      }[];
      for (const { id, data } of rows) {
        (lifecycle[collection] as Record<string, unknown>)[id] = JSON.parse(data);
        written.set(`${collection}/${id}`, data);
      }
    }
    return lifecycle;
  }

  function save(lifecycle: Lifecycle): void {
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('lifecycle', ?)`).run(
        JSON.stringify({ counters: lifecycle.counters, slotCap: lifecycle.slotCap }),
      );
      for (const collection of Object.keys(COLLECTIONS) as Collection[]) {
        const upsert = db.prepare(`INSERT OR REPLACE INTO ${COLLECTIONS[collection]} (id, seq, data) VALUES (?, ?, ?)`);
        for (const [id, entity] of Object.entries(lifecycle[collection])) {
          const data = JSON.stringify(entity);
          const key = `${collection}/${id}`;
          if (written.get(key) === data) continue;
          upsert.run(id, Number(id.slice(1)), data);
          written.set(key, data);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return { loadLifecycle: load, saveLifecycle: save, close: () => db.close() };
}
