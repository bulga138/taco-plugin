# taco-plugin — Plugin Context

**OpenCode plugin that captures raw telemetry for TACO benchmarking**

**Last Updated:** April 29, 2026
**Status:** 77/78 tests pass. Build: clean. Typecheck: clean. One known failing test (cost_share split, see Known Limitations).

---

## What taco-plugin Is

An OpenCode plugin that hooks into the LLM request/response lifecycle and writes detailed per-turn, per-tool, and per-step metrics into a dedicated SQLite database. TACO CLI reads this database to show cache efficiency, tool I/O detail, retrieval relevance, latency breakdowns, and benchmark comparisons.

Zero configuration, zero runtime dependencies — runs entirely on Bun built-ins.

## AI Agent Guidelines

When modifying this codebase:

**Always:**

- Run `bun run typecheck` and `bun test` after changes
- Follow existing patterns in neighboring files
- Swallow all errors with `console.error` — the plugin must never crash OpenCode
- Use `queueMicrotask()` for DB writes to avoid blocking the main thread
- Keep schema migrations backward-compatible (TACO CLI may be older)
- Update CONTEXT.md if architecture changes

**Never:**

- Add runtime dependencies — everything must use Bun built-ins (`bun:sqlite`, `Bun.gzipSync`, `Bun.CryptoHasher`)
- Write to the main OpenCode database (`opencode.db`) — plugin has its own DB
- Block the event loop with synchronous heavy computation
- Store secrets or user content in error messages

**Testing:**

- Unit tests: `bun test`
- All tests use in-memory SQLite (`:memory:`)
- Test files live in `tests/`

## How It Works

The plugin registers 6 OpenCode hooks that fire at different points in the LLM lifecycle:

| Hook                                   | Fires When               | Writes To                                                                    |
| -------------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `chat.params`                          | Before each LLM request  | `chat_params`, `token_estimates`                                             |
| `experimental.chat.system.transform`   | System prompt assembled  | `system_prompts`                                                             |
| `experimental.chat.messages.transform` | Context window assembled | `context_snapshots`                                                          |
| `tool.execute.before`                  | Tool call starts         | `tool_calls` (partial)                                                       |
| `tool.execute.after`                   | Tool call completes      | `tool_calls` (update), `tool_latency_breakdown`                              |
| `event`                                | SSE stream events        | `step_metrics`, `streaming_timing`, `token_estimates`, `retrieval_relevance` |

**Concurrency model:** All DB writes use `queueMicrotask()` to avoid blocking. Session-scoped `Map<string, Set<string>>` structures deduplicate first-occurrence events. Cleanup on `session.idle` prevents memory leaks.

**Database:** `~/.local/share/taco/plugin.db` — WAL mode so TACO CLI can read concurrently while the plugin writes.

## Database Schema (v3)

12 tables, all timestamps are Unix ms:

| Table                    | Purpose                                          | Key Columns                                                                              |
| ------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `meta`                   | Schema version tracking                          | `key`, `value`                                                                           |
| `chat_params`            | LLM request params per turn                      | `model_id`, `temperature`, `top_p`, `max_output_tokens`, cost rates                      |
| `system_prompts`         | Deduplicated system prompt snapshots             | `content_hash` (SHA-256), `content`, `token_count`                                       |
| `context_snapshots`      | Context window composition per turn              | `estimated_tokens`, `context_utilization`, `system_token_pct`, `tool_output_token_pct`   |
| `tool_calls`             | Full tool call data (input/output/timing)        | `tool`, `duration_ms`, `input_estimated_tokens`, `output_estimated_tokens`, `cost_share` |
| `step_metrics`           | Per-step token data from SSE events              | `cost`, `tokens_input`, `tokens_output`, `tokens_cache_read`, `tokens_cache_write`       |
| `streaming_timing`       | Streaming latency milestones                     | `time_to_first_token_ms`, `total_streaming_ms`                                           |
| `token_estimates`        | Multi-approach token estimates                   | `approach` (opencode/char-ratio/model-info), `estimated_cost`                            |
| `retrieval_relevance`    | How much of tool output the model used           | `fetched_tokens`, `referenced_tokens`, `relevance_ratio`, `scoring_method`               |
| `tool_latency_breakdown` | Per-phase latency for tool calls                 | `phase` (total/embedding/vector-search/file-io/network), `duration_ms`                   |
| `benchmark_tasks`        | Repeatable benchmark task definitions            | `id`, `description`, `expected_output_hint`                                              |
| `benchmark_runs`         | Aggregated results per (task, session, strategy) | `precision_score`, `avg_relevance`, `avg_ttft_ms`, `p95_query_ms`                        |

## Project Structure

```
taco-plugin/
├── package.json              # Zero runtime deps, Bun-only
├── tsconfig.json             # ESNext module, bundler resolution
├── bun.lock
├── src/
│   ├── index.ts              # Plugin entry point (exports PluginModule)
│   ├── plugin.ts             # Main plugin function, wires all 6 hooks
│   ├── db/
│   │   ├── schema.ts         # DDL for all tables, indexes, migrations
│   │   ├── connection.ts     # Lazy singleton bun:sqlite connection
│   │   └── writers.ts        # Insert/upsert functions for every table
│   ├── hooks/
│   │   ├── events.ts         # SSE event stream handler (step-finish, streaming, relevance)
│   │   └── system-prompt.ts  # System prompt capture + SHA-256 dedup
│   ├── analysis/
│   │   ├── relevance.ts      # Retrieval relevance scoring (line-overlap, substring-match)
│   │   └── benchmark.ts      # Benchmark task registration + run aggregation
│   ├── tokenizer/
│   │   └── index.ts          # Char-ratio token estimator (no external deps)
│   └── utils/
│       ├── compress.ts       # Gzip compress/decompress for large tool outputs (>10KB)
│       └── hash.ts           # SHA-256 hashing via Bun.CryptoHasher
├── tests/
│   ├── schema.test.ts
│   ├── writers.test.ts
│   ├── writers-full.test.ts
│   ├── relevance.test.ts
│   ├── benchmark.test.ts
│   ├── tokenizer.test.ts
│   ├── compress.test.ts
│   └── hash.test.ts
└── dist/                     # Compiled output (tsc)
```

**Cross-Reference Guide:**

When modifying these files, also update:

- `src/db/schema.ts` → TACO CLI's `src/data/plugin-db.ts` (reader queries must match)
- `src/db/writers.ts` → Corresponding hooks that call the writers
- `src/hooks/events.ts` → `src/db/writers.ts` (new event types need new writers)
- `src/analysis/relevance.ts` → `src/hooks/events.ts` (scoring is triggered from SSE handler)

## Integration

### With OpenCode

Registered in `opencode.json`:

```json
{ "plugin": ["taco-plugin"] }
```

The plugin exports a `PluginModule` with `id: 'taco-plugin'`. On process exit/SIGTERM, it flushes the WAL and closes the DB cleanly.

### With TACO CLI

TACO CLI reads `~/.local/share/taco/plugin.db` using `better-sqlite3` or `sql.js` (Node.js). The reader lives in the main TACO repo at `src/data/plugin-db.ts`. WAL mode enables concurrent read/write without locks.

**Important:** TACO CLI opens the plugin DB with its own connection — it does NOT reuse the main `getDbAsync()` singleton (which is bound to `opencode.db`).

## Data Flow

```
OpenCode process (Bun)                    TACO CLI (Node.js)
─────────────────────                     ──────────────────
chat.params hook ──────┐
system.transform ──────┤
messages.transform ────┤                  plugin-db.ts
tool.execute.before ───┼──→ plugin.db ──→ loadPlugin*()
tool.execute.after ────┤    (WAL mode)      functions
event (SSE stream) ────┘                     │
                                             ↓
                                    session-detail.ts
                                    benchmark.ts
                                    tui.ts
```

## Compression

Tool outputs larger than 10KB are gzip-compressed before storage. The `output_compressed` column (0/1) in `tool_calls` indicates whether decompression is needed on read. This keeps the DB size manageable for sessions with large file reads.

## Common Modification Patterns

**Adding a new hook:**

1. Add writer function in `src/db/writers.ts`
2. Add table DDL in `src/db/schema.ts` (bump `SCHEMA_VERSION`, add migration)
3. Wire the hook in `src/plugin.ts`
4. Add reader function in TACO's `src/data/plugin-db.ts`
5. Add tests in `tests/`

**Adding a new table:**

1. Add CREATE TABLE in `src/db/schema.ts`
2. Add migration in the version upgrade block
3. Bump `SCHEMA_VERSION`
4. Add writer in `src/db/writers.ts`
5. Add matching reader in TACO's `src/data/plugin-db.ts`

**Adding a new scoring method:**

1. Add scoring function in `src/analysis/relevance.ts`
2. Call it from `src/hooks/events.ts` where relevance is computed
3. Store with a new `scoring_method` value in `retrieval_relevance`

## Technical Stack

- **Runtime:** Bun (required)
- **Database:** `bun:sqlite` (WAL mode, synchronous=NORMAL)
- **Compression:** `Bun.gzipSync` / `Bun.gunzipSync`
- **Hashing:** `Bun.CryptoHasher` (SHA-256)
- **Tokenizers:**
  - `gpt-tokenizer` — exact for OpenAI models
  - `@lenml/tokenizer-claude` — near-exact for Claude
  - `@lenml/tokenizer-deepseek_v3` — near-exact for DeepSeek
  - Byte-ratio fallback (~3.8 bytes/token) for everything else
- **Build:** TypeScript compiler (`tsc`)
- **Testing:** `bun test`
- **Peer dependency:** `@opencode-ai/plugin >= 1.4.0`

## Development

```bash
cd taco-plugin
bun install            # Install dev dependencies
bun run build          # Compile TypeScript
bun test               # Run tests
bun run typecheck      # Check types
bun run dev            # Watch mode
```

## Known Limitations

**1. `tool_calls.message_id` is empty in `tool.execute.before`**
The assistant message ID is not available in the `before` hook — it's only available in the SSE event stream. The `tool_calls` table has `message_id` but it's stored as empty string in `before` and never enriched. This means tool calls cannot reliably join to `step_metrics` on `message_id`. This is a limitation of the OpenCode plugin SDK — the before hook only has access to the user message, not the assistant message that will be created.

**2. `tool_calls.truncated` field may never be populated**
The plugin checks `output.metadata?.truncated === true`, but the SDK may expose truncation reason differently (e.g., via a `reason: 'length'` field or different field name). The column exists in the schema but may stay as `false`/`0` unless OpenCode explicitly sets `metadata.truncated = true`.

**3. `cost_share` calculation edge case**
When all `tool_calls.output_size_bytes` values for a message are NULL, the proportional cost-share split defaults to 0 for all calls instead of splitting equally. This is a low-priority edge case (test `writers-full.test.ts` line 277-288 documents the expected behavior but the current implementation doesn't handle it).
