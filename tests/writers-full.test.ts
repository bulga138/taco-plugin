/**
 * Integration tests for src/db/writers.ts
 *
 * Uses Bun's mock.module() to inject an in-memory bun:sqlite database in place
 * of the real getPluginDb() singleton, so the writer functions can be tested
 * without touching the filesystem.
 *
 * Each describe block gets a fresh in-memory DB via beforeEach.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DDL } from '../src/db/schema.js';

// ─── DB factory shared across all describe blocks ─────────────────────────────

let _testDb: Database;

// Stub getPluginDb before any writer module is imported.
// mock.module() is hoisted by Bun's module system so this runs first.
mock.module('../src/db/connection.js', () => ({
  getPluginDb: () => _testDb,
  closePluginDb: () => {},
  OBSERVER_DB_PATH: ':memory:',
}));

// Now import the writers — they will call our stubbed getPluginDb().
const {
  writeChatParams,
  writeSystemPrompt,
  writeContextSnapshot,
  writeToolCallStart,
  writeToolCallEnd,
  updateToolCallCostShares,
  writeStepMetrics,
  writeStreamingTimingStart,
  updateStreamingField,
  writeTokenEstimate,
  writeRetrievalRelevance,
  writeToolLatencyBreakdown,
} = await import('../src/db/writers.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _testDb = new Database(':memory:');
  _testDb.run(DDL);
});

// ─── writeChatParams ──────────────────────────────────────────────────────────

describe('writeChatParams', () => {
  it('inserts a full row and reads it back', () => {
    writeChatParams({
      id: 'msg-1',
      sessionId: 'sess-1',
      timestamp: 1000,
      modelId: 'claude-sonnet',
      providerId: 'anthropic',
      agent: 'coder',
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 4096,
      modelContextLimit: 200000,
      modelOutputLimit: 8192,
      costInput: 0.000003,
      costOutput: 0.000015,
      costCacheRead: 0.0000003,
      costCacheWrite: 0.00000375,
      optionsJson: '{"stream":true}',
    });

    const row = _testDb.query<Record<string, unknown>, [string]>(`SELECT * FROM chat_params WHERE id = ?`).get('msg-1');

    expect(row).not.toBeNull();
    expect(row!.model_id).toBe('claude-sonnet');
    expect(row!.provider_id).toBe('anthropic');
    expect(row!.temperature).toBeCloseTo(0.7);
    expect(row!.model_context_limit).toBe(200000);
    expect(row!.options_json).toBe('{"stream":true}');
  });

  it('handles all-null optional fields', () => {
    writeChatParams({
      id: 'msg-null',
      sessionId: 'sess-1',
      timestamp: 1000,
      modelId: 'gpt-4',
      providerId: 'openai',
    });
    const row = _testDb
      .query<{ temperature: null; top_p: null }, [string]>(`SELECT temperature, top_p FROM chat_params WHERE id = ?`)
      .get('msg-null');
    expect(row!.temperature).toBeNull();
    expect(row!.top_p).toBeNull();
  });

  it('replaces on duplicate id (INSERT OR REPLACE)', () => {
    writeChatParams({ id: 'msg-dup', sessionId: 's', timestamp: 1, modelId: 'v1', providerId: 'p' });
    writeChatParams({ id: 'msg-dup', sessionId: 's', timestamp: 2, modelId: 'v2', providerId: 'p' });
    const rows = _testDb
      .query<{ model_id: string }, [string]>(`SELECT model_id FROM chat_params WHERE id = ?`)
      .all('msg-dup');
    expect(rows.length).toBe(1);
    expect(rows[0].model_id).toBe('v2');
  });
});

// ─── writeSystemPrompt ────────────────────────────────────────────────────────

describe('writeSystemPrompt', () => {
  it('inserts a system prompt row', () => {
    writeSystemPrompt({
      sessionId: 'sess-1',
      modelId: 'claude',
      timestamp: 1000,
      contentHash: 'abc123',
      content: 'You are a helpful assistant.',
      tokenCount: 7,
    });
    const row = _testDb
      .query<
        { content: string; token_count: number },
        [string]
      >(`SELECT content, token_count FROM system_prompts WHERE content_hash = ?`)
      .get('abc123');
    expect(row!.content).toBe('You are a helpful assistant.');
    expect(row!.token_count).toBe(7);
  });

  it('deduplicates on (session_id, content_hash) via INSERT OR IGNORE', () => {
    writeSystemPrompt({ sessionId: 's1', modelId: 'm', timestamp: 1, contentHash: 'h1', content: 'v1' });
    writeSystemPrompt({ sessionId: 's1', modelId: 'm', timestamp: 2, contentHash: 'h1', content: 'v2' });
    const rows = _testDb
      .query<
        { content: string },
        [string, string]
      >(`SELECT content FROM system_prompts WHERE session_id = ? AND content_hash = ?`)
      .all('s1', 'h1');
    // Should only have the first insertion
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe('v1');
  });

  it('allows same hash for different sessions', () => {
    writeSystemPrompt({ sessionId: 'sA', modelId: 'm', timestamp: 1, contentHash: 'same', content: 'c' });
    writeSystemPrompt({ sessionId: 'sB', modelId: 'm', timestamp: 1, contentHash: 'same', content: 'c' });
    const rows = _testDb
      .query<{ session_id: string }, []>(`SELECT session_id FROM system_prompts WHERE content_hash = 'same'`)
      .all();
    expect(rows.length).toBe(2);
  });
});

// ─── writeContextSnapshot ─────────────────────────────────────────────────────

describe('writeContextSnapshot', () => {
  it('inserts all columns correctly', () => {
    writeContextSnapshot({
      id: 'msg-ctx',
      sessionId: 'sess-1',
      timestamp: 1000,
      messageCount: 5,
      totalParts: 12,
      toolParts: 4,
      textParts: 8,
      estimatedTokens: 3000,
      contextUtilization: 0.015,
      systemTokenPct: null,
      toolOutputTokenPct: 0.6,
      conversationTokenPct: 0.4,
    });
    const row = _testDb
      .query<Record<string, unknown>, [string]>(`SELECT * FROM context_snapshots WHERE id = ?`)
      .get('msg-ctx');
    expect(row!.message_count).toBe(5);
    expect(row!.tool_parts).toBe(4);
    expect(row!.context_utilization as number).toBeCloseTo(0.015);
    expect(row!.system_token_pct).toBeNull();
  });
});

// ─── writeToolCallStart + writeToolCallEnd ────────────────────────────────────

describe('writeToolCallStart + writeToolCallEnd', () => {
  it('creates a pending row on start', () => {
    writeToolCallStart({
      id: 'call-1',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      tool: 'read_file',
      timestampStart: 1000,
      inputJson: '{"path":"src/index.ts"}',
      inputSizeBytes: 24,
      inputEstimatedTokens: 6,
    });
    const row = _testDb
      .query<{ status: string; tool: string }, [string]>(`SELECT status, tool FROM tool_calls WHERE id = ?`)
      .get('call-1');
    expect(row!.status).toBe('pending');
    expect(row!.tool).toBe('read_file');
  });

  it('completes the row and computes duration_ms on end', () => {
    writeToolCallStart({
      id: 'call-dur',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      tool: 'bash',
      timestampStart: 1000,
      inputJson: '{}',
      inputSizeBytes: 2,
    });
    writeToolCallEnd({
      id: 'call-dur',
      timestampEnd: 1500,
      status: 'completed',
      outputText: 'ok',
      outputCompressed: 0,
      outputSizeBytes: 2,
      outputEstimatedTokens: 1,
      title: 'Run bash',
      truncated: 0,
    });
    const row = _testDb
      .query<
        { status: string; duration_ms: number; title: string },
        [string]
      >(`SELECT status, duration_ms, title FROM tool_calls WHERE id = ?`)
      .get('call-dur');
    expect(row!.status).toBe('completed');
    expect(row!.duration_ms).toBe(500);
    expect(row!.title).toBe('Run bash');
  });

  it('sets duration_ms to null when start row is missing on end', () => {
    writeToolCallEnd({
      id: 'call-no-start',
      timestampEnd: 2000,
      status: 'error',
      errorText: 'oops',
    });
    // No row exists yet — UPDATE affects 0 rows; no crash
    const row = _testDb
      .query<{ id: string } | null, [string]>(`SELECT id FROM tool_calls WHERE id = ?`)
      .get('call-no-start');
    expect(row).toBeNull();
  });
});

// ─── updateToolCallCostShares ─────────────────────────────────────────────────

describe('updateToolCallCostShares', () => {
  function seedCall(id: string, msgId: string, outputBytes: number | null) {
    _testDb.run(
      `INSERT INTO tool_calls (id, session_id, message_id, tool, status, input_json, output_size_bytes)
       VALUES (?, 'sess', ?, 'read', 'completed', '{}', ?)`,
      [id, msgId, outputBytes],
    );
  }

  it('apportions cost proportionally by output_size_bytes', () => {
    seedCall('c1', 'msg-share', 300);
    seedCall('c2', 'msg-share', 700);
    updateToolCallCostShares('msg-share', 1.0);
    const c1 = _testDb
      .query<{ cost_share: number }, [string]>(`SELECT cost_share FROM tool_calls WHERE id = ?`)
      .get('c1');
    const c2 = _testDb
      .query<{ cost_share: number }, [string]>(`SELECT cost_share FROM tool_calls WHERE id = ?`)
      .get('c2');
    expect(c1!.cost_share).toBeCloseTo(0.3);
    expect(c2!.cost_share).toBeCloseTo(0.7);
  });

  it('splits equally when all output_size_bytes are null', () => {
    seedCall('ca', 'msg-equal', null);
    seedCall('cb', 'msg-equal', null);
    updateToolCallCostShares('msg-equal', 1.0);
    const ca = _testDb
      .query<{ cost_share: number }, [string]>(`SELECT cost_share FROM tool_calls WHERE id = ?`)
      .get('ca');
    const cb = _testDb
      .query<{ cost_share: number }, [string]>(`SELECT cost_share FROM tool_calls WHERE id = ?`)
      .get('cb');
    expect(ca!.cost_share).toBeCloseTo(0.5);
    expect(cb!.cost_share).toBeCloseTo(0.5);
  });

  it('does nothing when there are no completed calls for the message', () => {
    // Should not throw
    expect(() => updateToolCallCostShares('msg-empty', 1.0)).not.toThrow();
  });
});

// ─── writeStepMetrics ─────────────────────────────────────────────────────────

describe('writeStepMetrics', () => {
  it('inserts all token columns', () => {
    writeStepMetrics({
      id: 'step-1',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      timestamp: 1000,
      reason: 'tool-calls',
      cost: 0.025,
      tokensInput: 1000,
      tokensOutput: 300,
      tokensReasoning: 50,
      tokensCacheRead: 200,
      tokensCacheWrite: 80,
    });
    const row = _testDb
      .query<Record<string, unknown>, [string]>(`SELECT * FROM step_metrics WHERE id = ?`)
      .get('step-1');
    expect(row!.tokens_input).toBe(1000);
    expect(row!.tokens_reasoning).toBe(50);
    expect(row!.reason).toBe('tool-calls');
    expect(row!.cost as number).toBeCloseTo(0.025);
  });
});

// ─── writeStreamingTimingStart + updateStreamingField ────────────────────────

describe('writeStreamingTimingStart + updateStreamingField', () => {
  it('creates a timing row on start', () => {
    writeStreamingTimingStart('msg-t', 'sess-1', 1000);
    const row = _testDb
      .query<{ request_sent: number }, [string]>(`SELECT request_sent FROM streaming_timing WHERE message_id = ?`)
      .get('msg-t');
    expect(row!.request_sent).toBe(1000);
  });

  it('does not overwrite request_sent on duplicate (INSERT OR IGNORE)', () => {
    writeStreamingTimingStart('msg-dup-t', 'sess-1', 1000);
    writeStreamingTimingStart('msg-dup-t', 'sess-1', 9999);
    const row = _testDb
      .query<{ request_sent: number }, [string]>(`SELECT request_sent FROM streaming_timing WHERE message_id = ?`)
      .get('msg-dup-t');
    expect(row!.request_sent).toBe(1000);
  });

  it('sets milestone fields and does not overwrite first occurrence', () => {
    writeStreamingTimingStart('msg-m', 'sess-1', 1000);
    updateStreamingField('msg-m', 'first_part_received', 1100);
    updateStreamingField('msg-m', 'first_part_received', 9999); // should be ignored
    const row = _testDb
      .query<
        { first_part_received: number },
        [string]
      >(`SELECT first_part_received FROM streaming_timing WHERE message_id = ?`)
      .get('msg-m');
    expect(row!.first_part_received).toBe(1100);
  });

  it('computes time_to_first_token_ms and total_streaming_ms on message_completed', () => {
    writeStreamingTimingStart('msg-ttft', 'sess-1', 1000);
    updateStreamingField('msg-ttft', 'first_part_received', 1050);
    updateStreamingField('msg-ttft', 'first_text_received', 1200);
    updateStreamingField('msg-ttft', 'message_completed', 2000);

    const row = _testDb
      .query<
        { time_to_first_token_ms: number; total_streaming_ms: number },
        [string]
      >(`SELECT time_to_first_token_ms, total_streaming_ms FROM streaming_timing WHERE message_id = ?`)
      .get('msg-ttft');

    expect(row!.time_to_first_token_ms).toBe(200); // 1200 - 1000
    expect(row!.total_streaming_ms).toBe(950); // 2000 - 1050
  });
});

// ─── writeTokenEstimate ───────────────────────────────────────────────────────

describe('writeTokenEstimate', () => {
  it('inserts a token estimate row', () => {
    writeTokenEstimate({
      messageId: 'msg-te',
      sessionId: 'sess-1',
      approach: 'char-ratio',
      modelId: 'claude',
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      estimatedCost: 0.003,
      timestamp: 1000,
    });
    const row = _testDb
      .query<
        Record<string, unknown>,
        [string, string]
      >(`SELECT * FROM token_estimates WHERE message_id = ? AND approach = ?`)
      .get('msg-te', 'char-ratio');
    expect(row!.input_tokens).toBe(500);
    expect(row!.total_tokens).toBe(600);
  });

  it('deduplicates on (message_id, approach) via INSERT OR REPLACE', () => {
    writeTokenEstimate({
      messageId: 'm1',
      sessionId: 's',
      approach: 'opencode',
      modelId: 'gpt-4',
      inputTokens: 100,
      timestamp: 1,
    });
    writeTokenEstimate({
      messageId: 'm1',
      sessionId: 's',
      approach: 'opencode',
      modelId: 'gpt-4',
      inputTokens: 200,
      timestamp: 2,
    });
    const rows = _testDb
      .query<
        { input_tokens: number },
        [string, string]
      >(`SELECT input_tokens FROM token_estimates WHERE message_id = ? AND approach = ?`)
      .all('m1', 'opencode');
    expect(rows.length).toBe(1);
    expect(rows[0].input_tokens).toBe(200);
  });
});

// ─── writeRetrievalRelevance ──────────────────────────────────────────────────

describe('writeRetrievalRelevance', () => {
  it('inserts a relevance row', () => {
    writeRetrievalRelevance({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      toolCallId: 'call-rr',
      tool: 'read',
      fetchedTokens: 500,
      fetchedLines: 80,
      referencedTokens: 120,
      referencedLines: 20,
      relevanceRatio: 0.24,
      scoringMethod: 'line-overlap',
      timestamp: 1000,
    });
    const row = _testDb
      .query<
        { relevance_ratio: number; scoring_method: string },
        [string]
      >(`SELECT relevance_ratio, scoring_method FROM retrieval_relevance WHERE tool_call_id = ?`)
      .get('call-rr');
    expect(row!.relevance_ratio).toBeCloseTo(0.24);
    expect(row!.scoring_method).toBe('line-overlap');
  });
});

// ─── writeToolLatencyBreakdown ────────────────────────────────────────────────

describe('writeToolLatencyBreakdown', () => {
  it('inserts a latency phase row', () => {
    writeToolLatencyBreakdown({
      toolCallId: 'call-lat',
      sessionId: 'sess-1',
      phase: 'embedding',
      durationMs: 42,
      metadataJson: '{"model":"text-embedding-3-small"}',
      timestamp: 1000,
    });
    const row = _testDb
      .query<
        { phase: string; duration_ms: number; metadata_json: string },
        [string, string]
      >(`SELECT phase, duration_ms, metadata_json FROM tool_latency_breakdown WHERE tool_call_id = ? AND phase = ?`)
      .get('call-lat', 'embedding');
    expect(row!.duration_ms).toBe(42);
    expect(row!.metadata_json).toBe('{"model":"text-embedding-3-small"}');
  });
});
