/**
 * Insert / upsert helpers for every plugin table.
 * All functions accept plain objects and handle serialisation.
 * Errors are swallowed — the plugin must never crash OpenCode.
 */

import { getPluginDb } from './connection.js';

// ─── chat_params ──────────────────────────────────────────────────────────────

export interface ChatParamsRow {
  id: string;
  sessionId: string;
  timestamp: number;
  modelId: string;
  providerId: string;
  agent?: string | null;
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  maxOutputTokens?: number | null;
  modelContextLimit?: number | null;
  modelOutputLimit?: number | null;
  costInput?: number | null;
  costOutput?: number | null;
  costCacheRead?: number | null;
  costCacheWrite?: number | null;
  optionsJson?: string | null;
}

export function writeChatParams(row: ChatParamsRow): void {
  try {
    const db = getPluginDb();
    db.run(
      `INSERT OR REPLACE INTO chat_params
       (id, session_id, timestamp, model_id, provider_id, agent,
        temperature, top_p, top_k, max_output_tokens,
        model_context_limit, model_output_limit,
        cost_input, cost_output, cost_cache_read, cost_cache_write,
        options_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.sessionId,
        row.timestamp,
        row.modelId,
        row.providerId,
        row.agent ?? null,
        row.temperature ?? null,
        row.topP ?? null,
        row.topK ?? null,
        row.maxOutputTokens ?? null,
        row.modelContextLimit ?? null,
        row.modelOutputLimit ?? null,
        row.costInput ?? null,
        row.costOutput ?? null,
        row.costCacheRead ?? null,
        row.costCacheWrite ?? null,
        row.optionsJson ?? null,
      ],
    );
  } catch (err) {
    // Never crash the plugin — just log quietly
    console.error('[taco-plugin] writeChatParams error:', (err as Error).message);
  }
}

// ─── system_prompts ───────────────────────────────────────────────────────────

export interface SystemPromptRow {
  sessionId: string;
  modelId: string;
  timestamp: number;
  contentHash: string;
  content: string;
  tokenCount?: number | null;
}

export function writeSystemPrompt(row: SystemPromptRow): void {
  try {
    const db = getPluginDb();
    // INSERT OR IGNORE — dedup on (session_id, content_hash) UNIQUE constraint
    db.run(
      `INSERT OR IGNORE INTO system_prompts
       (session_id, model_id, timestamp, content_hash, content, token_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.sessionId, row.modelId, row.timestamp, row.contentHash, row.content, row.tokenCount ?? null],
    );
  } catch (err) {
    console.error('[taco-plugin] writeSystemPrompt error:', (err as Error).message);
  }
}

// ─── context_snapshots ────────────────────────────────────────────────────────

export interface ContextSnapshotRow {
  id: string;
  sessionId: string;
  timestamp: number;
  messageCount: number;
  totalParts: number;
  toolParts: number;
  textParts: number;
  estimatedTokens?: number | null;
  contextUtilization?: number | null;
  systemTokenPct?: number | null;
  toolOutputTokenPct?: number | null;
  conversationTokenPct?: number | null;
}

export function writeContextSnapshot(row: ContextSnapshotRow): void {
  try {
    const db = getPluginDb();
    db.run(
      `INSERT OR REPLACE INTO context_snapshots
       (id, session_id, timestamp, message_count, total_parts, tool_parts, text_parts,
        estimated_tokens, context_utilization,
        system_token_pct, tool_output_token_pct, conversation_token_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.sessionId,
        row.timestamp,
        row.messageCount,
        row.totalParts,
        row.toolParts,
        row.textParts,
        row.estimatedTokens ?? null,
        row.contextUtilization ?? null,
        row.systemTokenPct ?? null,
        row.toolOutputTokenPct ?? null,
        row.conversationTokenPct ?? null,
      ],
    );
  } catch (err) {
    console.error('[taco-plugin] writeContextSnapshot error:', (err as Error).message);
  }
}

// ─── tool_calls ───────────────────────────────────────────────────────────────

export interface ToolCallStartRow {
  id: string;
  sessionId: string;
  messageId: string;
  tool: string;
  timestampStart: number;
  inputJson: string;
  inputSizeBytes: number;
  inputEstimatedTokens?: number | null;
}

export function writeToolCallStart(row: ToolCallStartRow): void {
  try {
    const db = getPluginDb();
    db.run(
      `INSERT OR REPLACE INTO tool_calls
       (id, session_id, message_id, tool, timestamp_start, status,
        input_json, input_size_bytes, input_estimated_tokens)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        row.id,
        row.sessionId,
        row.messageId,
        row.tool,
        row.timestampStart,
        row.inputJson,
        row.inputSizeBytes,
        row.inputEstimatedTokens ?? null,
      ],
    );
  } catch (err) {
    console.error('[taco-plugin] writeToolCallStart error:', (err as Error).message);
  }
}

export interface ToolCallEndRow {
  id: string;
  timestampEnd: number;
  status: 'completed' | 'error';
  outputText: string;
  outputCompressed: boolean;
  outputSizeBytes: number;
  outputEstimatedTokens: number;
  nextTurnTokenImpact: number;
  title?: string | null;
  truncated: boolean;
  errorText?: string | null;
}

export function writeToolCallEnd(row: ToolCallEndRow): void {
  try {
    const db = getPluginDb();

    // First, fetch timestamp_start to compute duration_ms
    const startRow = db
      .query<{ timestamp_start: number }, [string]>(`SELECT timestamp_start FROM tool_calls WHERE id = ?`)
      .get(row.id);

    const durationMs = startRow ? row.timestampEnd - startRow.timestamp_start : null;

    db.run(
      `UPDATE tool_calls SET
         timestamp_end = ?, status = ?, output_text = ?, output_compressed = ?,
         output_size_bytes = ?, output_estimated_tokens = ?, duration_ms = ?,
         next_turn_token_impact = ?, title = ?, truncated = ?, error_text = ?
       WHERE id = ?`,
      [
        row.timestampEnd,
        row.status,
        row.outputText,
        row.outputCompressed ? 1 : 0,
        row.outputSizeBytes,
        row.outputEstimatedTokens,
        durationMs,
        row.nextTurnTokenImpact,
        row.title ?? null,
        row.truncated ? 1 : 0,
        row.errorText ?? null,
        row.id,
      ],
    );
  } catch (err) {
    console.error('[taco-plugin] writeToolCallEnd error:', (err as Error).message);
  }
}

// ─── tool_latency_breakdown ───────────────────────────────────────────────────

export interface ToolLatencyBreakdownRow {
  toolCallId: string;
  sessionId: string;
  phase: string;
  durationMs: number;
  metadataJson?: string | null;
  timestamp: number;
}

export function writeToolLatencyBreakdown(row: ToolLatencyBreakdownRow): void {
  try {
    const db = getPluginDb();
    db.run(
      `INSERT INTO tool_latency_breakdown
       (tool_call_id, session_id, phase, duration_ms, metadata_json, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.toolCallId, row.sessionId, row.phase, row.durationMs, row.metadataJson ?? null, row.timestamp],
    );
  } catch (err) {
    console.error('[taco-plugin] writeToolLatencyBreakdown error:', (err as Error).message);
  }
}

// ─── Cost allocation ──────────────────────────────────────────────────────────

/**
 * After a step-finish event with total cost C, allocate C proportionally
 * across all tool_calls for that message based on output_size_bytes.
 * Called from the event hook.
 */
export function updateToolCallCostShares(messageId: string, totalCost: number): void {
  try {
    const db = getPluginDb();

    // Sum of output_size_bytes for all completed tool calls in this message
    const sumRow = db
      .query<{ total_bytes: number | null }, [string]>(
        `SELECT SUM(output_size_bytes) AS total_bytes
         FROM tool_calls WHERE message_id = ? AND status = 'completed'`,
      )
      .get(messageId);

    const totalBytes = sumRow?.total_bytes ?? 0;
    if (totalCost === 0) return;

    // Update each call with its proportional share
    const rows = db
      .query<
        { id: string; output_size_bytes: number | null },
        [string]
      >(`SELECT id, output_size_bytes FROM tool_calls WHERE message_id = ? AND status = 'completed'`)
      .all(messageId);

    if (rows.length === 0) return;

    const updateShare = db.prepare(`UPDATE tool_calls SET cost_share = ? WHERE id = ?`);
    const updateAll = db.transaction(() => {
      for (const r of rows) {
        // If totalBytes === 0 (all NULL), split equally; otherwise split proportionally
        const share =
          totalBytes === 0
            ? totalCost / rows.length
            : ((r.output_size_bytes ?? 0) / totalBytes) * totalCost;
        updateShare.run(share, r.id);
      }
    });
    updateAll();
  } catch (err) {
    console.error('[taco-plugin] updateToolCallCostShares error:', (err as Error).message);
  }
}

// ─── step_metrics ─────────────────────────────────────────────────────────────

export interface StepMetricsRow {
  id: string;
  sessionId: string;
  messageId: string;
  timestamp: number;
  reason: string;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
}

export function writeStepMetrics(row: StepMetricsRow): void {
  try {
    const db = getPluginDb();
    db.run(
      `INSERT OR REPLACE INTO step_metrics
       (id, session_id, message_id, timestamp, reason, cost,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.sessionId,
        row.messageId,
        row.timestamp,
        row.reason,
        row.cost,
        row.tokensInput,
        row.tokensOutput,
        row.tokensReasoning,
        row.tokensCacheRead,
        row.tokensCacheWrite,
      ],
    );
  } catch (err) {
    console.error('[taco-plugin] writeStepMetrics error:', (err as Error).message);
  }
}

// ─── streaming_timing ─────────────────────────────────────────────────────────

export interface StreamingTimingStartRow {
  messageId: string;
  sessionId: string;
  timestamp: number;
}

export function writeStreamingTimingStart(messageId: string, sessionId: string, timestamp: number): void {
  try {
    const db = getPluginDb();
    // INSERT OR IGNORE — only the first call wins
    db.run(
      `INSERT OR IGNORE INTO streaming_timing
       (message_id, session_id, request_sent)
       VALUES (?, ?, ?)`,
      [messageId, sessionId, timestamp],
    );
  } catch (err) {
    console.error('[taco-plugin] writeStreamingTimingStart error:', (err as Error).message);
  }
}

export interface UpdateStreamingFieldRow {
  messageId: string;
  field: 'first_part_received' | 'first_text_received' | 'first_tool_call' | 'message_completed';
  timestamp: number;
}

export function updateStreamingField(messageId: string, field: UpdateStreamingFieldRow['field'], timestamp: number): void {
  try {
    const db = getPluginDb();
    // Only set if NULL (first occurrence)
    db.run(`UPDATE streaming_timing SET ${field} = ? WHERE message_id = ? AND ${field} IS NULL`, [
      timestamp,
      messageId,
    ]);

    // If this is message_completed, also compute derived columns
    if (field === 'message_completed') {
      db.run(
        `
        UPDATE streaming_timing
        SET
          time_to_first_token_ms = CASE
            WHEN request_sent IS NOT NULL AND first_text_received IS NOT NULL
            THEN first_text_received - request_sent
            ELSE NULL
          END,
          total_streaming_ms = CASE
            WHEN first_part_received IS NOT NULL
            THEN message_completed - first_part_received
            ELSE NULL
          END
        WHERE message_id = ?
      `,
        [messageId],
      );
    }
  } catch (err) {
    console.error('[taco-plugin] updateStreamingField error:', (err as Error).message);
  }
}

// ─── token_estimates ──────────────────────────────────────────────────────────

export interface TokenEstimateRow {
  messageId: string;
  sessionId: string;
  approach: 'opencode' | 'char-ratio' | 'model-info' | string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCost: number;
  timestamp: number;
}

export function writeTokenEstimate(row: TokenEstimateRow): void {
  try {
    const db = getPluginDb();
    db.run(
      `INSERT OR REPLACE INTO token_estimates
       (message_id, session_id, approach, model_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        total_tokens, estimated_cost, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.messageId,
        row.sessionId,
        row.approach,
        row.modelId,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.totalTokens,
        row.estimatedCost,
        row.timestamp,
      ],
    );
  } catch (err) {
    console.error('[taco-plugin] writeTokenEstimate error:', (err as Error).message);
  }
}

// ─── retrieval_relevance ──────────────────────────────────────────────────────

export interface RetrievalRelevanceRow {
  sessionId: string;
  messageId: string;
  toolCallId: string;
  tool: string;
  fetchedTokens: number;
  fetchedLines?: number | null;
  referencedTokens: number;
  referencedLines?: number | null;
  relevanceRatio: number;
  scoringMethod: 'line-overlap' | 'substring-match' | string;
  timestamp: number;
}

export function writeRetrievalRelevance(row: RetrievalRelevanceRow): void {
  try {
    const db = getPluginDb();
    db.run(
      `INSERT INTO retrieval_relevance
       (session_id, message_id, tool_call_id, tool,
        fetched_tokens, fetched_lines,
        referenced_tokens, referenced_lines,
        relevance_ratio, scoring_method, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.sessionId,
        row.messageId,
        row.toolCallId,
        row.tool,
        row.fetchedTokens,
        row.fetchedLines ?? null,
        row.referencedTokens,
        row.referencedLines ?? null,
        row.relevanceRatio,
        row.scoringMethod,
        row.timestamp,
      ],
    );
  } catch (err) {
    console.error('[taco-plugin] writeRetrievalRelevance error:', (err as Error).message);
  }
}

// ─── benchmark_tasks & benchmark_runs ─────────────────────────────────────────

export interface BenchmarkTaskRow {
  id: string;
  description: string;
  expectedOutputHint?: string | null;
  createdAt: number;
}

export function writeBenchmarkTask(row: BenchmarkTaskRow): void {
  try {
    const db = getPluginDb();
    db.run(
      `INSERT OR REPLACE INTO benchmark_tasks
       (id, description, expected_output_hint, created_at)
       VALUES (?, ?, ?, ?)`,
      [row.id, row.description, row.expectedOutputHint ?? null, row.createdAt],
    );
  } catch (err) {
    console.error('[taco-plugin] writeBenchmarkTask error:', (err as Error).message);
  }
}

export interface BenchmarkRunRow {
  taskId: string;
  sessionId: string;
  strategy: string;
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
  totalCost?: number | null;
  totalToolCalls?: number | null;
  totalFetchedTokens?: number | null;
  totalReferencedTokens?: number | null;
  precisionScore?: number | null;
  avgRelevance?: number | null;
  avgTtftMs?: number | null;
  avgToolDurationMs?: number | null;
  totalSessionMs?: number | null;
  avgQueryMs?: number | null;
  p50QueryMs?: number | null;
  p95QueryMs?: number | null;
  timestamp: number;
}

export function writeBenchmarkRun(row: BenchmarkRunRow): void {
  try {
    const db = getPluginDb();
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
        row.taskId,
        row.sessionId,
        row.strategy,
        row.totalInputTokens ?? null,
        row.totalOutputTokens ?? null,
        row.totalCost ?? null,
        row.totalToolCalls ?? null,
        row.totalFetchedTokens ?? null,
        row.totalReferencedTokens ?? null,
        row.precisionScore ?? null,
        row.avgRelevance ?? null,
        row.avgTtftMs ?? null,
        row.avgToolDurationMs ?? null,
        row.totalSessionMs ?? null,
        row.avgQueryMs ?? null,
        row.p50QueryMs ?? null,
        row.p95QueryMs ?? null,
        row.timestamp,
      ],
    );
  } catch (err) {
    console.error('[taco-plugin] writeBenchmarkRun error:', (err as Error).message);
  }
}
