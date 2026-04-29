/**
 * Integration tests for src/analysis/benchmark.ts
 *
 * Uses Bun's mock.module() to inject an in-memory bun:sqlite DB in place of
 * getPluginDb(). Seeds the required plugin tables, then calls
 * aggregateBenchmarkRun() and verifies the resulting benchmark_runs row.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DDL } from '../src/db/schema.js';

// ─── DB factory shared across all describe blocks ─────────────────────────────

let _testDb: Database;

mock.module('../src/db/connection.js', () => ({
  getPluginDb: () => _testDb,
  closePluginDb: () => {},
  OBSERVER_DB_PATH: ':memory:',
}));

const { registerBenchmarkTask, aggregateBenchmarkRun } = await import('../src/analysis/benchmark.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _testDb = new Database(':memory:');
  _testDb.run(DDL);
});

// ─── Helpers to seed data ─────────────────────────────────────────────────────

function seedStepMetrics(sessionId: string, rows: Array<{ input: number; output: number; cost: number }>) {
  for (const r of rows) {
    _testDb.run(
      `INSERT INTO step_metrics
       (id, session_id, message_id, timestamp, reason, cost,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
       VALUES (?, ?, 'msg', 0, 'stop', ?, ?, ?, 0, 0, 0)`,
      [Math.random().toString(36), sessionId, r.cost, r.input, r.output],
    );
  }
}

function seedToolCalls(sessionId: string, rows: Array<{ id: string; outputTokens: number; durationMs: number }>) {
  for (const r of rows) {
    _testDb.run(
      `INSERT INTO tool_calls
       (id, session_id, message_id, tool, status, input_json,
        output_estimated_tokens, duration_ms, output_size_bytes)
       VALUES (?, ?, 'msg', 'read', 'completed', '{}', ?, ?, ?)`,
      [r.id, sessionId, r.outputTokens, r.durationMs, r.outputTokens * 4],
    );
  }
}

function seedRelevance(
  sessionId: string,
  rows: Array<{ callId: string; referenced: number; fetched: number; ratio: number }>,
) {
  for (const r of rows) {
    _testDb.run(
      `INSERT INTO retrieval_relevance
       (session_id, message_id, tool_call_id, tool, fetched_tokens,
        referenced_tokens, relevance_ratio, scoring_method, timestamp)
       VALUES (?, 'msg', ?, 'read', ?, ?, ?, 'line-overlap', 0)`,
      [sessionId, r.callId, r.fetched, r.referenced, r.ratio],
    );
  }
}

function seedStreamingTiming(
  sessionId: string,
  rows: Array<{ msgId: string; sent: number; firstPart: number; firstText: number; completed: number }>,
) {
  for (const r of rows) {
    _testDb.run(
      `INSERT INTO streaming_timing
       (message_id, session_id, request_sent, first_part_received, first_text_received, message_completed,
        time_to_first_token_ms, total_streaming_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.msgId,
        sessionId,
        r.sent,
        r.firstPart,
        r.firstText,
        r.completed,
        r.firstText - r.sent,
        r.completed - r.firstPart,
      ],
    );
  }
}

function seedLatency(sessionId: string, callId: string, durationMs: number) {
  _testDb.run(
    `INSERT INTO tool_latency_breakdown (tool_call_id, session_id, phase, duration_ms, timestamp)
     VALUES (?, ?, 'total', ?, 0)`,
    [callId, sessionId, durationMs],
  );
}

// ─── registerBenchmarkTask ────────────────────────────────────────────────────

describe('registerBenchmarkTask', () => {
  it('inserts a task and reads it back', () => {
    registerBenchmarkTask('task-1', 'Find where errors are handled', 'handleError');
    const row = _testDb
      .query<
        { description: string; expected_output_hint: string },
        [string]
      >(`SELECT description, expected_output_hint FROM benchmark_tasks WHERE id = ?`)
      .get('task-1');
    expect(row!.description).toBe('Find where errors are handled');
    expect(row!.expected_output_hint).toBe('handleError');
  });

  it('upserts on duplicate id', () => {
    registerBenchmarkTask('task-up', 'v1');
    registerBenchmarkTask('task-up', 'v2');
    const rows = _testDb
      .query<{ description: string }, [string]>(`SELECT description FROM benchmark_tasks WHERE id = ?`)
      .all('task-up');
    expect(rows.length).toBe(1);
    expect(rows[0].description).toBe('v2');
  });

  it('stores null hint when not provided', () => {
    registerBenchmarkTask('task-no-hint', 'No hint task');
    const row = _testDb
      .query<{ expected_output_hint: null }, [string]>(`SELECT expected_output_hint FROM benchmark_tasks WHERE id = ?`)
      .get('task-no-hint');
    expect(row!.expected_output_hint).toBeNull();
  });
});

// ─── aggregateBenchmarkRun ────────────────────────────────────────────────────

describe('aggregateBenchmarkRun', () => {
  it('writes a benchmark_runs row with correct token/cost aggregates', () => {
    const sess = 'sess-agg';
    seedStepMetrics(sess, [
      { input: 1000, output: 200, cost: 0.01 },
      { input: 800, output: 150, cost: 0.008 },
    ]);
    seedToolCalls(sess, [
      { id: 'c1', outputTokens: 400, durationMs: 100 },
      { id: 'c2', outputTokens: 600, durationMs: 200 },
    ]);
    seedRelevance(sess, [
      { callId: 'c1', referenced: 160, fetched: 400, ratio: 0.4 },
      { callId: 'c2', referenced: 300, fetched: 600, ratio: 0.5 },
    ]);
    seedStreamingTiming(sess, [{ msgId: 'm1', sent: 1000, firstPart: 1050, firstText: 1200, completed: 2000 }]);
    seedLatency(sess, 'c1', 100);
    seedLatency(sess, 'c2', 200);

    registerBenchmarkTask('task-agg', 'Aggregation test');
    aggregateBenchmarkRun('task-agg', sess, 'full-file');

    const run = _testDb
      .query<
        Record<string, unknown>,
        [string, string]
      >(`SELECT * FROM benchmark_runs WHERE task_id = ? AND session_id = ?`)
      .get('task-agg', sess);

    expect(run).not.toBeNull();
    expect(run!.total_input_tokens).toBe(1800);
    expect(run!.total_output_tokens).toBe(350);
    expect(run!.total_cost as number).toBeCloseTo(0.018);
    expect(run!.total_tool_calls).toBe(2);
    expect(run!.total_fetched_tokens).toBe(1000);
    expect(run!.total_referenced_tokens).toBe(460);
    expect(run!.precision_score as number).toBeCloseTo(0.46);
    expect(run!.avg_relevance as number).toBeCloseTo(0.45);
    expect(run!.strategy).toBe('full-file');
  });

  it('computes p50/p95 query latency from tool_latency_breakdown', () => {
    const sess = 'sess-lat';
    seedLatency(sess, 'x1', 50);
    seedLatency(sess, 'x2', 100);
    seedLatency(sess, 'x3', 150);
    seedLatency(sess, 'x4', 200);

    registerBenchmarkTask('task-lat', 'Latency test');
    aggregateBenchmarkRun('task-lat', sess, 'rag-chunk');

    const run = _testDb
      .query<
        Record<string, unknown>,
        [string, string]
      >(`SELECT avg_query_ms, p50_query_ms, p95_query_ms FROM benchmark_runs WHERE task_id = ? AND session_id = ?`)
      .get('task-lat', sess);

    expect(run!.avg_query_ms).toBe(125); // (50+100+150+200)/4
    expect(run!.p50_query_ms).toBe(100); // ceil(50%) idx = 2 → sorted[1] = 100
    expect(run!.p95_query_ms).toBe(200); // ceil(95%) idx = 4 → sorted[3] = 200
  });

  it('computes total_session_ms from streaming_timing', () => {
    const sess = 'sess-wall';
    seedStreamingTiming(sess, [
      { msgId: 'w1', sent: 1000, firstPart: 1010, firstText: 1100, completed: 2000 },
      { msgId: 'w2', sent: 2100, firstPart: 2110, firstText: 2200, completed: 3500 },
    ]);

    registerBenchmarkTask('task-wall', 'Wall clock test');
    aggregateBenchmarkRun('task-wall', sess, 'hybrid');

    const run = _testDb
      .query<
        { total_session_ms: number },
        [string, string]
      >(`SELECT total_session_ms FROM benchmark_runs WHERE task_id = ? AND session_id = ?`)
      .get('task-wall', sess);

    expect(run!.total_session_ms).toBe(2500); // 3500 - 1000
  });

  it('handles an empty session gracefully (no crash, nulls/zeros)', () => {
    registerBenchmarkTask('task-empty', 'Empty session');
    expect(() => aggregateBenchmarkRun('task-empty', 'sess-empty', 'full-file')).not.toThrow();

    const run = _testDb
      .query<
        Record<string, unknown>,
        [string, string]
      >(`SELECT * FROM benchmark_runs WHERE task_id = ? AND session_id = ?`)
      .get('task-empty', 'sess-empty');

    // Row should be written but metrics are 0 / null
    expect(run).not.toBeNull();
    expect(run!.total_input_tokens).toBe(0);
    expect(run!.precision_score).toBeNull();
    expect(run!.avg_ttft_ms).toBeNull();
  });
});
