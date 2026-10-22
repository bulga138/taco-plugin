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

  const db = new Database(DB_PATH, { create: true });

  try {
    // Apply DDL (idempotent CREATE IF NOT EXISTS statements).
    // The DDL opens with the connection pragmas, busy_timeout first.
    db.run(DDL);

    // WAL is what lets the TACO CLI read while we write. If the filesystem
    // lacks shared-memory support the pragma silently leaves the old journal
    // mode in place, and readers then block writers — the exact symptom this
    // module exists to avoid. Say so instead of degrading quietly.
    const journalMode = db.query<{ journal_mode: string }, []>(`PRAGMA journal_mode`).get();
    if (journalMode?.journal_mode !== 'wal') {
      console.error(
        '[taco-plugin] WAL unavailable — journal mode is',
        journalMode?.journal_mode,
        '(readers will block writers)',
      );
    }

    // Run migrations (ALTER TABLE ADD COLUMN — safe to re-run, duplicate column errors ignored)
    for (const migration of MIGRATIONS) {
      try {
        db.run(migration);
      } catch {
        // Column already exists — safe to ignore
      }
    }

    // Write or update schema version
    const existing = db.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'schema_version'`).get();

    if (!existing) {
      db.run(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, [String(SCHEMA_VERSION)]);
    } else if (Number(existing.value) < SCHEMA_VERSION) {
      db.run(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, [String(SCHEMA_VERSION)]);
    }
  } catch (err) {
    // Don't cache a half-initialised connection — the next caller retries.
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw err;
  }

  _db = db;
  return _db;
}

/** Call this on process exit to flush WAL and close cleanly. */
export function closePluginDb(): void {
  if (_db) {
    try {
      // PASSIVE never blocks — TRUNCATE stalls exit while other OpenCode
      // processes hold the write lock.
      _db.run('PRAGMA wal_checkpoint(PASSIVE)');
      _db.close();
    } catch {
      // ignore close errors
    }
    _db = null;
  }
}

/** DB path — exported so TACO CLI can read the same file. */
export { DB_PATH as PLUGIN_DB_PATH };
