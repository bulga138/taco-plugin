/**
 * Concurrency tests for the shared plugin DB.
 *
 * The plugin DB is written by every OpenCode process on the machine. Without
 * a busy timeout SQLite fails a colliding write instantly with SQLITE_BUSY,
 * and the telemetry row is silently dropped.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUSY_TIMEOUT_MS, DDL } from '../src/db/schema.js';

const HOLD_MS = 150;
const dirs: string[] = [];
const workers: Worker[] = [];

/** A temp DB opened exactly the way the plugin opens its own. */
function tempDb(): { file: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'taco-lock-'));
  dirs.push(dir);
  const file = join(dir, 'plugin.db');
  const db = new Database(file, { create: true });
  db.run(DDL);
  return { file, db };
}

/** Start the lock holder and resolve once it owns the write lock. */
async function holdWriteLock(file: string): Promise<Worker> {
  const worker = new Worker(new URL('./lock-holder.ts', import.meta.url));
  workers.push(worker);
  const locked = new Promise<void>((resolve, reject) => {
    worker.onmessage = e => {
      if (e.data === 'locked') resolve();
    };
    worker.onerror = reject;
  });
  worker.postMessage({ file, holdMs: HOLD_MS });
  await locked;
  return worker;
}

afterEach(() => {
  for (const w of workers.splice(0)) w.terminate();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* the worker may still hold the file open — a leftover temp dir is harmless */
    }
  }
});

describe('shared DB write contention', () => {
  it('opens the connection with a non-zero busy timeout', () => {
    const { db } = tempDb();
    const row = db.query<{ timeout: number }, []>(`PRAGMA busy_timeout`).get();
    expect(row?.timeout).toBe(BUSY_TIMEOUT_MS);
    expect(BUSY_TIMEOUT_MS).toBeGreaterThan(0);
    db.close();
  });

  it('enables WAL, so readers never block writers', () => {
    const { db } = tempDb();
    const row = db.query<{ journal_mode: string }, []>(`PRAGMA journal_mode`).get();
    expect(row?.journal_mode).toBe('wal');
    db.close();
  });

  it('fails fast without a busy timeout (the bug)', async () => {
    const { file } = tempDb();
    await holdWriteLock(file);

    const db = new Database(file);
    db.run('PRAGMA busy_timeout = 0');
    expect(() => db.run("INSERT INTO meta (key, value) VALUES ('writer', 'x')")).toThrow(
      /database is locked/,
    );
    db.close();
  });

  it('waits for the lock instead of dropping the row', async () => {
    const { file, db } = tempDb();
    await holdWriteLock(file);

    const started = Date.now();
    db.run("INSERT INTO meta (key, value) VALUES ('writer', 'x')");
    const elapsed = Date.now() - started;

    // It waited for the holder to commit instead of failing.
    expect(elapsed).toBeGreaterThanOrEqual(HOLD_MS);
    expect(elapsed).toBeLessThan(BUSY_TIMEOUT_MS + 2000);

    const row = db.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'writer'`).get();
    expect(row?.value).toBe('x');
    db.close();
  });
});
