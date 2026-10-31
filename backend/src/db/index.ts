import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: DB): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map((r) => r.version),
  );
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    // Table rebuilds (to change CHECK constraints) need FK enforcement off; it can't be toggled inside a transaction.
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(db, () => {
        db.exec(sql);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`migration ${f} broke foreign keys: ${JSON.stringify(broken.slice(0, 3))}`);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(f, nowIso());
      });
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
    ran.push(f);
  }
  return ran;
}

const txDepth = new WeakMap<DB, number>();

/** Runs fn in a transaction; a nested call joins the outer transaction. */
export function tx<T>(db: DB, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) {
    txDepth.set(db, depth + 1);
    try {
      return fn();
    } finally {
      txDepth.set(db, depth);
    }
  }
  db.exec('BEGIN');
  txDepth.set(db, 1);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth.set(db, 0);
  }
}

export const nowIso = (): string => new Date().toISOString();

let shared: DB | null = null;
/** Process-wide DB at data/jobhunter.sqlite (lazy so tests can use in-memory DBs). */
export async function getDb(): Promise<DB> {
  if (!shared) {
    const { config } = await import('../config.js');
    shared = openDb(config.paths.db);
  }
  return shared;
}
