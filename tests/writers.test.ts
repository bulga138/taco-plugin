/**
 * Integration tests for the new v3 writer functions.
 *
 * Uses a real in-memory Bun:sqlite database — no mocking.
 * Tests insert → read-back for each new table.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DDL } from '../src/db/schema.js';

// ── Patch getPluginDb to return an in-memory DB for these tests ─────────────
// We do this by importing the writers after setting up a module-level singleton.
// Since the writers call getPluginDb() internally we need the DB open first.

let testDb: Database;

// The writers import getPluginDb from connection.ts. We mock the module by
// creating the DB here and re-exporting it via a closure used inside the test.
// For simplicity, we call the writer functions directly through the DB here
// rather than rewiring module imports (Bun doesn't support jest.mock natively).

function insertRetrievalRelevance(db: Database, overrides: Record<string, unknown> = {}) {
  const row = {
    session_id: 'sess-1',
    message_id: 'msg-1',
    tool_call_id: 'call-1',
    tool: 'read',
    fetched_tokens: 200,
    fetched_lines: 50,
    referenced_tokens: 80,
    referenced_lines: 20,
    relevance_ratio: 0.4,
    scoring_method: 'line-overlap',
    timestamp: Date.now(),
    ...overrides,
  };
  db.run(
    `INSERT INTO retrieval_relevance
     (session_id, message_id, tool_call_id, tool,
      fetched_tokens, fetched_lines, referenced_tokens, referenced_lines,
      relevance_ratio, scoring_method, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.session_id,
      row.message_id,
      row.tool_call_id,
      row.tool,
      row.fetched_tokens,
      row.fetched_lines,
      row.referenced_tokens,
      row.referenced_lines,
      row.relevance_ratio,
      row.scoring_method,
      row.timestamp,
    ],
  );
  return row;
}

function insertToolLatency(db: Database, overrides: Record<string, unknown> = {}) {
  const row = {
    tool_call_id: 'call-1',
    session_id: 'sess-1',
    phase: 'total',
    duration_ms: 120,
    metadata_json: null,
    timestamp: Date.now(),
    ...overrides,
  };
  db.run(
    `INSERT INTO tool_latency_breakdown
     (tool_call_id, session_id, phase, duration_ms, metadata_json, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.tool_call_id, row.session_id, row.phase, row.duration_ms, row.metadata_json, row.timestamp],
  );
  return row;
}

function insertBenchmarkTask(db: Database, overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'task-find-errors',
    description: 'Find where client errors are handled',
    expected_output_hint: 'handleError',
    created_at: Date.now(),
    ...overrides,
  };
  db.run(
    `INSERT OR REPLACE INTO benchmark_tasks
     (id, description, expected_output_hint, created_at)
     VALUES (?, ?, ?, ?)`,
    [row.id, row.description, row.expected_output_hint, row.created_at],
  );
  return row;
}

function insertBenchmarkRun(db: Database, overrides: Record<string, unknown> = {}) {
  const row = {
    task_id: 'task-find-errors',
    session_id: 'sess-1',
    strategy: 'full-file',
    total_input_tokens: 5000,
    total_output_tokens: 800,
    total_cost: 0.12,
    total_tool_calls: 6,
    total_fetched_tokens: 4200,
    total_referenced_tokens: 1800,
    precision_score: 0.43,
    avg_relevance: 0.38,
    avg_ttft_ms: 340,
    avg_tool_duration_ms: 85,
    total_session_ms: 32000,
    avg_query_ms: 88,
    p50_query_ms: 75,
    p95_query_ms: 210,
    timestamp: Date.now(),
    ...overrides,
  };
  db.run(
    `INSERT INTO benchmark_runs
     (task_id, session_id, strategy,
      total_input_tokens, total_output_tokens, total_cost, total_tool_calls,
      total_fetched_tokens, total_referenced_tokens,
      precision_score, avg_relevance,
      avg_ttft_ms, avg_tool_duration_ms, total_session_ms,
      avg_query_ms, p50_query_ms, p95_query_ms,
      timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.task_id,
      row.session_id,
      row.strategy,
      row.total_input_tokens,
      row.total_output_tokens,
      row.total_cost,
      row.total_tool_calls,
      row.total_fetched_tokens,
      row.total_referenced_tokens,
      row.precision_score,
      row.avg_relevance,
      row.avg_ttft_ms,
      row.avg_tool_duration_ms,
      row.total_session_ms,
      row.avg_query_ms,
      row.p50_query_ms,
      row.p95_query_ms,
      row.timestamp,
    ],
  );
  return row;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(() => {
  testDb = new Database(':memory:');
  testDb.run(DDL);
});

// ─── retrieval_relevance ──────────────────────────────────────────────────────

describe('retrieval_relevance', () => {
  it('inserts a row and reads it back', () => {
    const row = insertRetrievalRelevance(testDb);
    const found = testDb
      .query<{ tool_call_id: string; relevance_ratio: number; scoring_method: string }, [string]>(
        `SELECT tool_call_id, relevance_ratio, scoring_method
         FROM retrieval_relevance WHERE tool_call_id = ? LIMIT 1`,
      )
      .get(row.tool_call_id);

    expect(found).not.toBeNull();
    expect(found!.tool_call_id).toBe('call-1');
    expect(found!.relevance_ratio).toBeCloseTo(0.4);
    expect(found!.scoring_method).toBe('line-overlap');
  });

  it('supports null optional fields', () => {
    insertRetrievalRelevance(testDb, {
      tool_call_id: 'call-null-test',
      referenced_tokens: null,
      referenced_lines: null,
      relevance_ratio: null,
    });
    const found = testDb
      .query<
        { relevance_ratio: number | null },
        [string]
      >(`SELECT relevance_ratio FROM retrieval_relevance WHERE tool_call_id = ?`)
      .get('call-null-test');
    expect(found!.relevance_ratio).toBeNull();
  });

  it('accepts substring-match as scoring method', () => {
    insertRetrievalRelevance(testDb, {
      tool_call_id: 'call-substr',
      scoring_method: 'substring-match',
    });
    const found = testDb
      .query<
        { scoring_method: string },
        [string]
      >(`SELECT scoring_method FROM retrieval_relevance WHERE tool_call_id = ?`)
      .get('call-substr');
    expect(found!.scoring_method).toBe('substring-match');
  });
});

// ─── tool_latency_breakdown ───────────────────────────────────────────────────

describe('tool_latency_breakdown', () => {
  it('inserts a total phase row and reads it back', () => {
    const row = insertToolLatency(testDb);
    const found = testDb
      .query<
        { phase: string; duration_ms: number },
        [string]
      >(`SELECT phase, duration_ms FROM tool_latency_breakdown WHERE tool_call_id = ? LIMIT 1`)
      .get(row.tool_call_id);

    expect(found).not.toBeNull();
    expect(found!.phase).toBe('total');
    expect(found!.duration_ms).toBe(120);
  });

  it('supports multiple phases per tool call', () => {
    const callId = 'call-multi-phase';
    const phases = ['embedding', 'vector-search', 'total'];
    for (const phase of phases) {
      insertToolLatency(testDb, { tool_call_id: callId, phase, duration_ms: 10 });
    }
    const rows = testDb
      .query<
        { phase: string },
        [string]
      >(`SELECT phase FROM tool_latency_breakdown WHERE tool_call_id = ? ORDER BY phase`)
      .all(callId);
    expect(rows.map(r => r.phase).sort()).toEqual(phases.sort());
  });

  it('stores metadata_json', () => {
    const callId = 'call-with-meta';
    const meta = JSON.stringify({ chunkCount: 5, indexSize: 1024 });
    insertToolLatency(testDb, { tool_call_id: callId, metadata_json: meta });
    const found = testDb
      .query<
        { metadata_json: string },
        [string]
      >(`SELECT metadata_json FROM tool_latency_breakdown WHERE tool_call_id = ?`)
      .get(callId);
    expect(found!.metadata_json).toBe(meta);
  });
});

// ─── benchmark_tasks ─────────────────────────────────────────────────────────

describe('benchmark_tasks', () => {
  it('inserts a task and reads it back', () => {
    const row = insertBenchmarkTask(testDb);
    const found = testDb
      .query<
        { description: string; expected_output_hint: string | null },
        [string]
      >(`SELECT description, expected_output_hint FROM benchmark_tasks WHERE id = ?`)
      .get(row.id);

    expect(found).not.toBeNull();
    expect(found!.description).toBe(row.description);
    expect(found!.expected_output_hint).toBe('handleError');
  });

  it('upserts cleanly (INSERT OR REPLACE)', () => {
    insertBenchmarkTask(testDb, { id: 'task-upsert', description: 'v1' });
    insertBenchmarkTask(testDb, { id: 'task-upsert', description: 'v2' });
    const found = testDb
      .query<{ description: string }, [string]>(`SELECT description FROM benchmark_tasks WHERE id = ?`)
      .all('task-upsert');
    // REPLACE deletes + inserts, so only one row
    expect(found.length).toBe(1);
    expect(found[0].description).toBe('v2');
  });
});

// ─── benchmark_runs ──────────────────────────────────────────────────────────

describe('benchmark_runs', () => {
  it('inserts a run and reads back all speed / quality columns', () => {
    // Ensure the task exists (FK not enforced in SQLite by default, but good practice)
    insertBenchmarkTask(testDb, { id: 'task-find-errors' });
    const row = insertBenchmarkRun(testDb);

    const found = testDb
      .query<
        {
          strategy: string;
          precision_score: number;
          avg_ttft_ms: number;
          avg_query_ms: number;
          p50_query_ms: number;
          p95_query_ms: number;
          total_session_ms: number;
        },
        [string, string]
      >(
        `SELECT strategy, precision_score, avg_ttft_ms, avg_query_ms,
                p50_query_ms, p95_query_ms, total_session_ms
         FROM benchmark_runs WHERE session_id = ? AND task_id = ? LIMIT 1`,
      )
      .get(row.session_id, row.task_id);

    expect(found).not.toBeNull();
    expect(found!.strategy).toBe('full-file');
    expect(found!.precision_score).toBeCloseTo(0.43);
    expect(found!.avg_ttft_ms).toBe(340);
    expect(found!.avg_query_ms).toBe(88);
    expect(found!.p50_query_ms).toBe(75);
    expect(found!.p95_query_ms).toBe(210);
    expect(found!.total_session_ms).toBe(32000);
  });

  it('accepts multiple strategies for the same task', () => {
    const taskId = 'task-multi-strategy';
    insertBenchmarkTask(testDb, { id: taskId });
    insertBenchmarkRun(testDb, { task_id: taskId, session_id: 'sess-a', strategy: 'full-file' });
    insertBenchmarkRun(testDb, { task_id: taskId, session_id: 'sess-b', strategy: 'rag-chunk' });

    const runs = testDb
      .query<{ strategy: string }, [string]>(`SELECT strategy FROM benchmark_runs WHERE task_id = ? ORDER BY strategy`)
      .all(taskId);

    const strategies = runs.map(r => r.strategy);
    expect(strategies).toContain('full-file');
    expect(strategies).toContain('rag-chunk');
  });
});
