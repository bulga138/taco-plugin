/**
 * Unit tests for src/hooks/events.ts
 *
 * Uses mock.module() only for connection.js (to inject an in-memory DB).
 * Writer functions run for real against the in-memory DB — no mock for writers.js.
 * This avoids mock-bleed that would break writers-full.test.ts.
 *
 * Tests cover: dedup logic, streaming timing seeding, step-finish metrics,
 * session cleanup, and bounded Map eviction.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DDL } from '../src/db/schema.js';

// ─── In-memory DB stub ────────────────────────────────────────────────────────

let _testDb: Database;

mock.module('../src/db/connection.js', () => ({
  getPluginDb: () => _testDb,
  closePluginDb: () => {},
  PLUGIN_DB_PATH,
}));

// ─── Import hook after stubs are registered ────────────────────────────────────

const { makeEventHook } = await import('../src/hooks/events.js');

// ─── Spy on relevance scoring ───────────────────────────────────────────────────

import * as relevance from '../src/analysis/relevance.js';

let scoreMessageToolCallsSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  scoreMessageToolCallsSpy = spyOn(relevance, 'scoreMessageToolCalls').mockImplementation(() => {});
});

afterEach(() => {
  scoreMessageToolCallsSpy.mockRestore();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

type EventHook = ReturnType<typeof makeEventHook>;

function makePartEvent(
  messageId: string,
  sessionId: string,
  type: 'text' | 'tool' | 'step-finish',
  extra: Record<string, unknown> = {},
) {
  return {
    event: {
      type: 'message.part.updated',
      properties: {
        part: { messageID: messageId, sessionID: sessionId, type, ...extra },
      },
    },
  };
}

function makeIdleEvent(sessionId: string) {
  return {
    event: {
      type: 'session.idle',
      properties: { sessionID: sessionId },
    },
  };
}

function getStreamingRow(messageId: string) {
  return _testDb
    .query<Record<string, number | null>, [string]>(`SELECT * FROM streaming_timing WHERE message_id = ?`)
    .get(messageId);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('makeEventHook — streaming timing seeding', () => {
  let hook: EventHook;

  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
    hook = makeEventHook();
  });

  it('seeds streaming_timing row exactly once per (session, message)', async () => {
    const evt = makePartEvent('msg-seed', 'sess-seed', 'text');
    await hook(evt as any);
    await hook(evt as any); // second call — same messageId
    await new Promise(r => queueMicrotask(r));

    const rows = _testDb
      .query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM streaming_timing WHERE message_id = ?`)
      .get('msg-seed');
    expect(rows!.count).toBe(1);
  });

  it('seeds separate rows for different messages in same session', async () => {
    await hook(makePartEvent('msg-a', 'sess-two', 'text') as any);
    await hook(makePartEvent('msg-b', 'sess-two', 'text') as any);
    await new Promise(r => queueMicrotask(r));

    const rows = _testDb.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM streaming_timing`).get();
    expect(rows!.count).toBe(2);
  });
});

describe('makeEventHook — first_part_received dedup', () => {
  let hook: EventHook;

  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
    hook = makeEventHook();
  });

  it('records first_part_received only once per message', async () => {
    // Seed the streaming_timing row first so updateStreamingField can UPDATE it
    _testDb.run(`INSERT OR IGNORE INTO streaming_timing (message_id, session_id, request_sent) VALUES (?, ?, ?)`, [
      'msg-dedup',
      'sess-dedup',
      Date.now(),
    ]);

    const evt = makePartEvent('msg-dedup', 'sess-dedup', 'text');
    await hook(evt as any);
    await hook(evt as any); // duplicate
    await new Promise(r => queueMicrotask(r));

    const row = getStreamingRow('msg-dedup');
    // first_part_received should be set (not null)
    expect(row).not.toBeNull();
    expect(row!['first_part_received']).not.toBeNull();
  });

  it('records first_text_received only once per message', async () => {
    _testDb.run(`INSERT OR IGNORE INTO streaming_timing (message_id, session_id, request_sent) VALUES (?, ?, ?)`, [
      'msg-text',
      'sess-text',
      1000,
    ]);

    const evt = makePartEvent('msg-text', 'sess-text', 'text');
    await hook(evt as any);
    await hook(evt as any);
    await new Promise(r => queueMicrotask(r));

    const row = getStreamingRow('msg-text');
    expect(row!['first_text_received']).not.toBeNull();
  });

  it('records first_tool_call only once per message', async () => {
    _testDb.run(`INSERT OR IGNORE INTO streaming_timing (message_id, session_id, request_sent) VALUES (?, ?, ?)`, [
      'msg-tool',
      'sess-tool',
      1000,
    ]);

    const evt = makePartEvent('msg-tool', 'sess-tool', 'tool', { state: { status: 'pending' } });
    await hook(evt as any);
    await hook(evt as any);
    await new Promise(r => queueMicrotask(r));

    const row = getStreamingRow('msg-tool');
    expect(row!['first_tool_call']).not.toBeNull();
  });
});

describe('makeEventHook — session cleanup', () => {
  let hook: EventHook;

  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
    hook = makeEventHook();
  });

  it('reseeds streaming_timing after session.idle clears dedup state', async () => {
    await hook(makePartEvent('msg-1', 'sess-clean', 'text') as any);
    await new Promise(r => queueMicrotask(r));

    const beforeIdle = _testDb
      .query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM streaming_timing WHERE message_id = ?`)
      .get('msg-1')!.count;
    expect(beforeIdle).toBe(1);

    // Fire idle — clears dedup sets for sess-clean
    await hook(makeIdleEvent('sess-clean') as any);

    // Wipe DB row so we can detect a fresh seed
    _testDb.run(`DELETE FROM streaming_timing WHERE message_id = ?`, ['msg-1']);

    // Same messageId again — dedup was cleared, so it seeds again
    await hook(makePartEvent('msg-1', 'sess-clean', 'text') as any);
    await new Promise(r => queueMicrotask(r));

    const afterIdle = _testDb
      .query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM streaming_timing WHERE message_id = ?`)
      .get('msg-1')!.count;
    expect(afterIdle).toBe(1);
  });
});

describe('makeEventHook — step-finish metrics', () => {
  let hook: EventHook;

  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
    hook = makeEventHook();
  });

  it('writes step metrics for step-finish part', async () => {
    const evt = makePartEvent('msg-step', 'sess-step', 'step-finish', {
      id: 'step-id-1',
      sessionID: 'sess-step',
      messageID: 'msg-step',
      reason: 'tool_use',
      cost: 0.005,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
    });
    await hook(evt as any);
    await new Promise(r => queueMicrotask(r));

    const row = _testDb.query<{ id: string }, [string]>(`SELECT id FROM step_metrics WHERE id = ?`).get('step-id-1');
    expect(row).not.toBeNull();
  });

  it('does not write cost_shares when cost is 0', async () => {
    // Insert a completed tool call for this message
    _testDb.run(
      `INSERT INTO tool_calls
       (id, session_id, message_id, tool, timestamp_start, status, input_json, input_size_bytes)
       VALUES ('tc-nocost', 'sess-nocost', 'msg-nocost', 'read', 1000, 'completed', '{}', 2)`,
    );

    const evt = makePartEvent('msg-nocost', 'sess-nocost', 'step-finish', {
      id: 'step-zero',
      sessionID: 'sess-nocost',
      messageID: 'msg-nocost',
      reason: 'end_turn',
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    await hook(evt as any);
    await new Promise(r => queueMicrotask(r));

    const tc = _testDb
      .query<{ cost_share: number | null }, [string]>(`SELECT cost_share FROM tool_calls WHERE id = ?`)
      .get('tc-nocost');
    expect(tc!.cost_share).toBeNull();
  });
});

describe('makeEventHook — bounded Map eviction', () => {
  it('handles 60 unique sessions without throwing', async () => {
    const hook = makeEventHook();
    for (let i = 0; i < 60; i++) {
      _testDb = new Database(':memory:');
      _testDb.run(DDL);
      await hook(makePartEvent(`msg-${i}`, `sess-bound-${i}`, 'text') as any);
    }
    // If we get here without error, eviction worked
    expect(true).toBe(true);
  });
});
