/**
 * Lazy singleton bun:sqlite connection for the plugin DB.
 *
 * - WAL mode for concurrent reads from TACO CLI while the plugin writes.
 * - DB is stored at ~/.local/share/taco/plugin.db (XDG data dir).
 * - Schema is created on first open; future migrations use ALTER TABLE.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { DDL, SCHEMA_VERSION, MIGRATIONS } from './schema.js';

const DB_PATH = join(homedir(), '.local', 'share', 'taco', 'plugin.db');

let _db: Database | null = null;

export function getPluginDb(): Database {
  if (_db) return _db;

  // Ensure directory exists
  mkdirSync(dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH, { create: true });

  // Apply DDL (idempotent CREATE IF NOT EXISTS statements)
  _db.run(DDL);

  // Run migrations (ALTER TABLE ADD COLUMN — safe to re-run, duplicate column errors ignored)
  for (const migration of MIGRATIONS) {
    try {
      _db.run(migration);
    } catch {
      // Column already exists — safe to ignore
    }
  }

  // Write or update schema version
  const existing = _db.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'schema_version'`).get();

  if (!existing) {
    _db.run(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, [String(SCHEMA_VERSION)]);
  } else if (Number(existing.value) < SCHEMA_VERSION) {
    _db.run(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, [String(SCHEMA_VERSION)]);
  }

  return _db;
}

/** Call this on process exit to flush WAL and close cleanly. */
export function closePluginDb(): void {
  if (_db) {
    try {
      _db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      _db.close();
    } catch {
      // ignore close errors
    }
    _db = null;
  }
}

/** DB path — exported so TACO CLI can read the same file. */
export { DB_PATH as OBSERVER_DB_PATH };
