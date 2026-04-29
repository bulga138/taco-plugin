/**
 * Benchmark task/run aggregation.
 *
 * Provides two public functions:
 *
 *   registerBenchmarkTask(id, description, hint?)
 *     — Upserts a task definition. Call this before the session starts.
 *
 *   aggregateBenchmarkRun(taskId, sessionId, strategy)
 *     — Reads all plugin tables for the session and writes a single
 *       summary row to benchmark_runs. Call this after the session ends
 *       (e.g. on session.idle or process exit).
 *
 * Query performance stats (avg/p50/p95) are computed from
 * tool_latency_breakdown where phase = 'total'. These are populated by
 * the plugin's tool hooks for every tool call.
 *
 * Never throws — errors are caught and logged quietly.
 */

import { getPluginDb } from '../db/connection.js';
import { writeBenchmarkTask, writeBenchmarkRun } from '../db/writers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compute percentile from a sorted array of numbers. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register (or update) a benchmark task definition.
 * Safe to call repeatedly — uses INSERT OR REPLACE.
 */
export function registerBenchmarkTask(id: string, description: string, expectedOutputHint?: string): void {
  writeBenchmarkTask({
    id,
    description,
    expectedOutputHint: expectedOutputHint ?? null,
    createdAt: Date.now(),
  });
}

/**
 * Aggregate all plugin data for a session into a single benchmark_runs row.
 *
 * Reads from: step_metrics, tool_calls, retrieval_relevance,
 *             streaming_timing, tool_latency_breakdown.
 *
 * Speed / query performance columns use tool_latency_breakdown phase='total'
 * (written by the plugin's tool hooks), enabling p50/p95 comparisons between
 * strategies even without a RAG-specific breakdown.
 */
export function aggregateBenchmarkRun(
  taskId: string,
  sessionId: string,
  strategy: 'full-file' | 'rag-chunk' | 'hybrid' | string,
): void {
  try {
    const db = getPluginDb();
    const now = Date.now();

    // ── Token / cost aggregates from step_metrics ─────────────────────────
    const stepRow = db
      .query<
        {
          total_input: number;
          total_output: number;
          total_cost: number;
        },
        [string]
      >(
        `SELECT
           COALESCE(SUM(tokens_input),  0) AS total_input,
           COALESCE(SUM(tokens_output), 0) AS total_output,
           COALESCE(SUM(cost),          0) AS total_cost
         FROM step_metrics WHERE session_id = ?`,
      )
      .get(sessionId);

    // ── Tool call aggregates ───────────────────────────────────────────────
    const toolRow = db
      .query<
        {
          total_calls: number;
          total_fetched: number;
          avg_dur: number | null;
        },
        [string]
      >(
        `SELECT
           COUNT(*)                                  AS total_calls,
           COALESCE(SUM(output_estimated_tokens), 0) AS total_fetched,
           AVG(duration_ms)                          AS avg_dur
         FROM tool_calls
         WHERE session_id = ? AND status = 'completed'`,
      )
      .get(sessionId);

    // ── Retrieval relevance aggregates ────────────────────────────────────
    const relevRow = db
      .query<
        {
          total_referenced: number;
          avg_relevance: number | null;
        },
        [string]
      >(
        `SELECT
           COALESCE(SUM(referenced_tokens), 0) AS total_referenced,
           AVG(relevance_ratio)                AS avg_relevance
         FROM retrieval_relevance WHERE session_id = ?`,
      )
      .get(sessionId);

    const totalFetched = toolRow?.total_fetched ?? 0;
    const totalReferenced = relevRow?.total_referenced ?? 0;
    const precisionScore = totalFetched > 0 ? Math.min(1, totalReferenced / totalFetched) : null;

    // ── Streaming timing (TTFT) ───────────────────────────────────────────
    const ttftRow = db
      .query<{ avg_ttft: number | null }, [string]>(
        `SELECT AVG(time_to_first_token_ms) AS avg_ttft
         FROM streaming_timing WHERE session_id = ?`,
      )
      .get(sessionId);

    // ── Session wall-clock: first request_sent → last message_completed ───
    const wallRow = db
      .query<
        {
          first_sent: number | null;
          last_done: number | null;
        },
        [string]
      >(
        `SELECT MIN(request_sent) AS first_sent, MAX(message_completed) AS last_done
         FROM streaming_timing WHERE session_id = ?`,
      )
      .get(sessionId);

    const totalSessionMs =
      wallRow?.first_sent != null && wallRow?.last_done != null ? wallRow.last_done - wallRow.first_sent : null;

    // ── Query latency stats from tool_latency_breakdown phase='total' ─────
    const latencyRows = db
      .query<{ duration_ms: number }, [string, string]>(
        `SELECT duration_ms FROM tool_latency_breakdown
         WHERE session_id = ? AND phase = ?
         ORDER BY duration_ms ASC`,
      )
      .all(sessionId, 'total');

    const durations = latencyRows.map(r => r.duration_ms);
    const avgQueryMs =
      durations.length > 0 ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : null;
    const p50QueryMs = percentile(durations, 50);
    const p95QueryMs = percentile(durations, 95);

    // ── Write the summary row ─────────────────────────────────────────────
    writeBenchmarkRun({
      taskId,
      sessionId,
      strategy,
      totalInputTokens: stepRow?.total_input ?? null,
      totalOutputTokens: stepRow?.total_output ?? null,
      totalCost: stepRow?.total_cost ?? null,
      totalToolCalls: toolRow?.total_calls ?? null,
      totalFetchedTokens: totalFetched || null,
      totalReferencedTokens: totalReferenced || null,
      precisionScore,
      avgRelevance: relevRow?.avg_relevance ?? null,
      avgTtftMs: ttftRow?.avg_ttft != null ? Math.round(ttftRow.avg_ttft) : null,
      avgToolDurationMs: toolRow?.avg_dur != null ? Math.round(toolRow.avg_dur) : null,
      totalSessionMs,
      avgQueryMs,
      p50QueryMs,
      p95QueryMs,
      timestamp: now,
    });
  } catch (err) {
    console.error('[taco-plugin] aggregateBenchmarkRun error:', (err as Error).message);
  }
}
