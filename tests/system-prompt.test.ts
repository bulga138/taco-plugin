/**
 * Unit tests for src/hooks/system-prompt.ts
 *
 * Uses mock.module() only for connection.js (to inject an in-memory DB).
 * Writer functions run for real — no mock for writers.js to avoid mock-bleed
 * that would break writers-full.test.ts.
 *
 * Tests cover: content capture, deduplication via content hash, empty content
 * early return, and token count derivation.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DDL } from '../src/db/schema.js';

// ─── In-memory DB stub ────────────────────────────────────────────────────────

let _testDb: Database;

mock.module('../src/db/connection.js', () => ({
  getPluginDb: () => _testDb,
  closePluginDb: () => {},
  PLUGIN_DB_PATH: ':memory:',
}));

// ─── Import hook after stubs ──────────────────────────────────────────────────

const { captureSystemPrompt } = await import('../src/hooks/system-prompt.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeParts(lines: string[]) {
  return lines.map(text => ({ type: 'text', text }));
}

function getRows() {
  return _testDb
    .query<
      { content: string; content_hash: string; token_count: number | null },
      []
    >(`SELECT content, content_hash, token_count FROM system_prompts`)
    .all();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('captureSystemPrompt — basic capture', () => {
  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
  });

  it('inserts a row with the joined content', async () => {
    captureSystemPrompt('sess-sp', 'claude-3-5-sonnet', makeParts(['You are a helpful assistant.']));
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('You are a helpful assistant.');
  });

  it('joins multiple system parts with double newline', async () => {
    captureSystemPrompt('sess-sp', 'claude-3-5-sonnet', makeParts(['Line one.', 'Line two.']));
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    expect(rows[0]!.content).toBe('Line one.\n\nLine two.');
  });

  it('stores a non-zero token count', async () => {
    captureSystemPrompt('sess-sp', 'claude-3-5-sonnet', makeParts(['You are a helpful assistant.']));
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    expect(rows[0]!.token_count).toBeGreaterThan(0);
  });
});

describe('captureSystemPrompt — empty content early return', () => {
  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
  });

  it('does not insert a row when parts array is empty', async () => {
    captureSystemPrompt('sess-sp', 'claude-3-5-sonnet', makeParts([]));
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    expect(rows).toHaveLength(0);
  });
});

describe('captureSystemPrompt — deduplication', () => {
  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
  });

  it('only inserts one DB row when the same content is seen twice (INSERT OR IGNORE)', async () => {
    const content = makeParts(['You are a helpful assistant.']);
    captureSystemPrompt('sess-sp', 'claude-3-5-sonnet', content);
    captureSystemPrompt('sess-sp', 'claude-3-5-sonnet', content);
    await new Promise(r => queueMicrotask(r));

    const count = _testDb.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM system_prompts`).get()!.count;
    expect(count).toBe(1);
  });

  it('produces the same content_hash for identical content', async () => {
    captureSystemPrompt('sess-sp', 'claude-3-5-sonnet', makeParts(['Same content.']));
    captureSystemPrompt('sess-sp', 'claude-3-5-sonnet', makeParts(['Same content.']));
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    // Exactly one row due to INSERT OR IGNORE dedup
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content_hash).toBeTruthy();
  });

  it('inserts two rows for different content', async () => {
    captureSystemPrompt('s1', 'claude-3-5-sonnet', makeParts(['Content A.']));
    captureSystemPrompt('s2', 'claude-3-5-sonnet', makeParts(['Content B.']));
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.content_hash).not.toBe(rows[1]!.content_hash);
  });
});
