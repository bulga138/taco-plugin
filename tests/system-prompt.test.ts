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

const { makeSystemPromptHook } = await import('../src/hooks/system-prompt.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeInput(sessionID = 'sess-sp', modelId = 'claude-3-5-sonnet') {
  return { sessionID, model: { id: modelId } };
}

function makeOutput(lines: string[]) {
  return { system: lines };
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

describe('makeSystemPromptHook — basic capture', () => {
  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
  });

  it('inserts a row with the joined content', async () => {
    const hook = makeSystemPromptHook();
    await hook(makeInput() as any, makeOutput(['You are a helpful assistant.']) as any);
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('You are a helpful assistant.');
  });

  it('joins multiple system lines with double newline', async () => {
    const hook = makeSystemPromptHook();
    await hook(makeInput() as any, makeOutput(['Line one.', 'Line two.']) as any);
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    expect(rows[0]!.content).toBe('Line one.\n\nLine two.');
  });

  it('stores a non-zero token count', async () => {
    const hook = makeSystemPromptHook();
    await hook(makeInput() as any, makeOutput(['You are a helpful assistant.']) as any);
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    expect(rows[0]!.token_count).toBeGreaterThan(0);
  });
});

describe('makeSystemPromptHook — empty content early return', () => {
  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
  });

  it('does not insert a row when system array is empty', async () => {
    const hook = makeSystemPromptHook();
    await hook(makeInput() as any, makeOutput([]) as any);
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    expect(rows).toHaveLength(0);
  });
});

describe('makeSystemPromptHook — deduplication', () => {
  beforeEach(() => {
    _testDb = new Database(':memory:');
    _testDb.run(DDL);
  });

  it('only inserts one DB row when the same content is seen twice (INSERT OR IGNORE)', async () => {
    const hook = makeSystemPromptHook();
    const content = ['You are a helpful assistant.'];
    await hook(makeInput() as any, makeOutput(content) as any);
    await hook(makeInput() as any, makeOutput(content) as any);
    await new Promise(r => queueMicrotask(r));

    const count = _testDb.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM system_prompts`).get()!.count;
    expect(count).toBe(1);
  });

  it('produces the same content_hash for identical content', async () => {
    const hook = makeSystemPromptHook();
    await hook(makeInput() as any, makeOutput(['Same content.']) as any);
    await hook(makeInput() as any, makeOutput(['Same content.']) as any);
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    // Exactly one row due to INSERT OR IGNORE dedup
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content_hash).toBeTruthy();
  });

  it('inserts two rows for different content', async () => {
    const hook = makeSystemPromptHook();
    await hook(makeInput('s1') as any, makeOutput(['Content A.']) as any);
    await hook(makeInput('s2') as any, makeOutput(['Content B.']) as any);
    await new Promise(r => queueMicrotask(r));

    const rows = getRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.content_hash).not.toBe(rows[1]!.content_hash);
  });
});
