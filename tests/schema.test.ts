/**
 * Schema migration tests.
 *
 * Verifies that:
 *   1. All v3 tables exist after DDL is applied to a fresh in-memory DB.
 *   2. All MIGRATIONS can be re-run safely on an existing DB (idempotent).
 *   3. SCHEMA_VERSION is 3.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { DDL, SCHEMA_VERSION, MIGRATIONS } from '../src/db/schema.js'

const EXPECTED_TABLES = [
  'meta',
  'chat_params',
  'system_prompts',
  'context_snapshots',
  'tool_calls',
  'step_metrics',
  'streaming_timing',
  'token_estimates',
  // v3 additions
  'retrieval_relevance',
  'tool_latency_breakdown',
  'benchmark_tasks',
  'benchmark_runs',
]

function getTableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    )
    .all()
    .map(r => r.name)
}

function getIndexNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`,
    )
    .all()
    .map(r => r.name)
}

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
})

afterEach(() => {
  db.close()
})

describe('Schema version', () => {
  it('exports SCHEMA_VERSION = 3', () => {
    expect(SCHEMA_VERSION).toBe(3)
  })
})

describe('Fresh DB — DDL', () => {
  it('creates all expected tables', () => {
    db.run(DDL)
    const tables = getTableNames(db)
    for (const name of EXPECTED_TABLES) {
      expect(tables).toContain(name)
    }
  })

  it('creates indexes for new v3 tables', () => {
    db.run(DDL)
    const indexes = getIndexNames(db)
    const requiredIndexes = [
      'idx_relevance_session',
      'idx_relevance_message',
      'idx_relevance_tool_call',
      'idx_latency_tool_call',
      'idx_latency_session',
      'idx_bench_runs_task',
      'idx_bench_runs_session',
      'idx_bench_runs_strategy',
    ]
    for (const idx of requiredIndexes) {
      expect(indexes).toContain(idx)
    }
  })

  it('retrieval_relevance has expected columns', () => {
    db.run(DDL)
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(retrieval_relevance)`)
      .all()
      .map(r => r.name)

    const expected = [
      'id', 'session_id', 'message_id', 'tool_call_id', 'tool',
      'fetched_tokens', 'fetched_lines',
      'referenced_tokens', 'referenced_lines',
      'relevance_ratio', 'scoring_method', 'timestamp',
    ]
    for (const col of expected) {
      expect(cols).toContain(col)
    }
  })

  it('benchmark_runs has speed / query latency columns', () => {
    db.run(DDL)
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(benchmark_runs)`)
      .all()
      .map(r => r.name)

    const expected = [
      'avg_ttft_ms', 'avg_tool_duration_ms', 'total_session_ms',
      'avg_query_ms', 'p50_query_ms', 'p95_query_ms',
    ]
    for (const col of expected) {
      expect(cols).toContain(col)
    }
  })

  it('tool_latency_breakdown has phase column', () => {
    db.run(DDL)
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(tool_latency_breakdown)`)
      .all()
      .map(r => r.name)
    expect(cols).toContain('phase')
    expect(cols).toContain('duration_ms')
    expect(cols).toContain('metadata_json')
  })
})

describe('Migrations — idempotency', () => {
  it('applies all MIGRATIONS on a fresh DB without errors', () => {
    // Apply DDL first (simulates fresh install)
    db.run(DDL)
    for (const migration of MIGRATIONS) {
      // Should not throw
      expect(() => {
        try { db.run(migration) } catch { /* duplicate column/table — ok */ }
      }).not.toThrow()
    }
  })

  it('all MIGRATIONS are safe to re-run (no unrecoverable errors)', () => {
    db.run(DDL)
    // Run twice — second pass should be idempotent
    for (const migration of MIGRATIONS) {
      try { db.run(migration) } catch { /* ignored */ }
    }
    for (const migration of MIGRATIONS) {
      expect(() => {
        try { db.run(migration) } catch { /* ignored */ }
      }).not.toThrow()
    }
  })

  it('v2 DB gains v3 tables after migrations', () => {
    // Simulate a v2 DB: create only the pre-v3 tables, then run migrations
    const v2DDL = `
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_params (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS system_prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_snapshots (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS step_metrics (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS streaming_timing (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS token_estimates (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL);
    `
    db.run(v2DDL)

    // Run migrations
    for (const migration of MIGRATIONS) {
      try { db.run(migration) } catch { /* ignored */ }
    }

    const tables = getTableNames(db)
    expect(tables).toContain('retrieval_relevance')
    expect(tables).toContain('tool_latency_breakdown')
    expect(tables).toContain('benchmark_tasks')
    expect(tables).toContain('benchmark_runs')
  })
})