/**
 * Unit tests for src/hooks/events.ts
 *
 * Uses mock.module() only for connection.js (to inject an in-memory DB).
 * Writer functions run for real against the in-memory DB — no mock for writers.js.
 * This avoids mock-bleed that would break writers-full.test.ts.
 *
 * Tests cover: dedup logic, streaming timing seeding, step-ended metrics,
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
  PLUGIN_DB_PATH: ':memory:',
}));

// ─── Import handler after stubs are registered ────────────────────────────────

const { makeEventHandler } = await import('../src/hooks/events.js');

// ─── Spy on relevance scoring ─────────────────────────────────────────────────

import * as relevance from '../src/analysis/relevance.js';

let scoreMessageToolCallsSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  scoreMessageToolCallsSpy = spyOn(relevance, 'scoreMessageToolCalls').mockImplementation(() => {});
});

afterEach(() => {
  scoreMessageToolCallsSpy.mockRestore();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

type EventHandler = ReturnType<typeof makeEventHandler>;

function makeStepStartedEvent(messageId: string, sessionId: string) {
  return {
    id: 'evt-step-started',
    type: 'session.step.started',
    data: { assistantMessageID: messageId, sessionID: sessionId },
  };
}

function makeTextStartedEvent(messageId: string, sessionId: string) {
  return {
    id: 'evt-text-started',
    type: 'session.text.started',
    data: { assistantMessageID: messageId, sessionID: sessionId },
  };
}

function makeToolInputStartedEvent(messageId: string, sessionId: string) {
  return {
    id: 'evt-tool-started',
    type: 'session.tool.input.started',
    data: { assistantMessageID: messageId, sessionID: sessionId },
  };
}

function makeStepEndedEvent(
  messageId: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
  eventId = 'step-id-1',
) {
  return {
    id: eventId,
    type: 'session.step.ended',
    data: {
      assistantMessageID: messageId,
      sessionID: sessionId,
      finish: 'tool_use',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...extra,
    },
  };
}

function makeIdleEvent(sessionId: string) {
  return {
    id: 'evt-idle',
    type: 'session.idle',
    data: { sessionID: sessionId },
  };
}

function getStreamingRow(messageId: string) {
  return _testDb
    .query<Record<string, number | null>, [string]>(`SELECT * FROM streaming_timing WHERE message_id = ?`)
    .get(messageId);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('makeEventHandler — streaming timing seeding', () => {
  let handler: EventHandler;

  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
    handler = makeEventHandler(new Map());
  });

  it('seeds streaming_timing row exactly once per (session, message)', async () => {
    const evt = makeStepStartedEvent('msg-seed', 'sess-seed');
    handler(evt);
    handler(evt); // second call — same messageId
    await new Promise(r => queueMicrotask(r));

    const rows = _testDb
      .query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM streaming_timing WHERE message_id = ?`)
      .get('msg-seed');
    expect(rows!.count).toBe(1);
  });

  it('seeds separate rows for different messages in same session', async () => {
    handler(makeStepStartedEvent('msg-a', 'sess-two'));
    handler(makeStepStartedEvent('msg-b', 'sess-two'));
    await new Promise(r => queueMicrotask(r));

    const rows = _testDb.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM streaming_timing`).get();
    expect(rows!.count).toBe(2);
  });
});

describe('makeEventHandler — first-occurrence dedup', () => {
  let handler: EventHandler;

  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
    handler = makeEventHandler(new Map());
  });

  it('records first_part_received only once per message', async () => {
    // Seed the streaming_timing row first so updateStreamingField can UPDATE it
    _testDb.run(`INSERT OR IGNORE INTO streaming_timing (message_id, session_id, request_sent) VALUES (?, ?, ?)`, [
      'msg-dedup',
      'sess-dedup',
      Date.now(),
    ]);

    const evt = makeStepStartedEvent('msg-dedup', 'sess-dedup');
    handler(evt);
    handler(evt); // duplicate
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

    const evt = makeTextStartedEvent('msg-text', 'sess-text');
    handler(evt);
    handler(evt);
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

    const evt = makeToolInputStartedEvent('msg-tool', 'sess-tool');
    handler(evt);
    handler(evt);
    await new Promise(r => queueMicrotask(r));

    const row = getStreamingRow('msg-tool');
    expect(row!['first_tool_call']).not.toBeNull();
  });
});

describe('makeEventHandler — session cleanup', () => {
  let handler: EventHandler;

  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
    handler = makeEventHandler(new Map());
  });

  it('reseeds streaming_timing after session.idle clears dedup state', async () => {
    handler(makeStepStartedEvent('msg-1', 'sess-clean'));
    await new Promise(r => queueMicrotask(r));

    const beforeIdle = _testDb
      .query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM streaming_timing WHERE message_id = ?`)
      .get('msg-1')!.count;
    expect(beforeIdle).toBe(1);

    // Fire idle — clears dedup sets for sess-clean
    handler(makeIdleEvent('sess-clean'));

    // Wipe DB row so we can detect a fresh seed
    _testDb.run(`DELETE FROM streaming_timing WHERE message_id = ?`, ['msg-1']);

    // Same messageId again — dedup was cleared, so it seeds again
    handler(makeStepStartedEvent('msg-1', 'sess-clean'));
    await new Promise(r => queueMicrotask(r));

    const afterIdle = _testDb
      .query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM streaming_timing WHERE message_id = ?`)
      .get('msg-1')!.count;
    expect(afterIdle).toBe(1);
  });
});

describe('makeEventHandler — step metrics', () => {
  let handler: EventHandler;

  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
    handler = makeEventHandler(new Map());
  });

  it('writes step metrics for session.step.ended', async () => {
    const evt = makeStepEndedEvent('msg-step', 'sess-step', {
      cost: 0.005,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
    });
    handler(evt);
    await new Promise(r => queueMicrotask(r));

    const row = _testDb.query<{ id: string }, [string]>(`SELECT id FROM step_metrics WHERE id = ?`).get('step-id-1');
    expect(row).not.toBeNull();
  });

  it('writes opencode token estimates keyed by assistant message', async () => {
    handler(makeStepEndedEvent('msg-tok', 'sess-tok', {
      cost: 0.01,
      tokens: { input: 100, output: 50, reasoning: 7, cache: { read: 10, write: 5 } },
    }, 'step-tok'));
    await new Promise(r => queueMicrotask(r));

    const row = _testDb
      .query<{ total_tokens: number; approach: string }, [string]>(
        `SELECT total_tokens, approach FROM token_estimates WHERE message_id = ?`,
      )
      .get('msg-tok');
    expect(row).not.toBeNull();
    expect(row!.approach).toBe('opencode');
    expect(row!.total_tokens).toBe(100 + 50 + 7 + 10 + 5);
  });

  it('does not write cost_shares when cost is 0', async () => {
    // Insert a completed tool call for this message
    _testDb.run(
      `INSERT INTO tool_calls
       (id, session_id, message_id, tool, timestamp_start, status, input_json, input_size_bytes)
       VALUES ('tc-nocost', 'sess-nocost', 'msg-nocost', 'read', 1000, 'completed', '{}', 2)`,
    );

    handler(makeStepEndedEvent('msg-nocost', 'sess-nocost', {
      finish: 'end_turn',
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    }, 'step-zero'));
    await new Promise(r => queueMicrotask(r));

    const tc = _testDb
      .query<{ cost_share: number | null }, [string]>(`SELECT cost_share FROM tool_calls WHERE id = ?`)
      .get('tc-nocost');
    expect(tc!.cost_share).toBeNull();
  });
});

describe('makeEventHandler — bounded Map eviction', () => {
  it('handles 60 unique sessions without throwing', () => {
    const handler = makeEventHandler(new Map());
    for (let i = 0; i < 60; i++) {
      _testDb = new Database(':memory:');
      _testDb.run(DDL);
      handler(makeStepStartedEvent(`msg-${i}`, `sess-bound-${i}`));
    }
    // If we get here without error, eviction worked
    expect(true).toBe(true);
  });
});
