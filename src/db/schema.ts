/**
 * Plugin DB schema — all CREATE TABLE / INDEX statements.
 * Tables are versioned with a `schema_version` meta table.
 * All writes come from the plugin (Bun:sqlite).
 * Reads come from the TACO CLI (better-sqlite3 / sql.js).
 */

export const SCHEMA_VERSION = 3;

export const DDL = /* sql */ `

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;

-- ─── Schema version tracking ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─── Chat parameters per assistant turn ──────────────────────────────────────
-- Captured via the chat.params hook before each LLM request.

CREATE TABLE IF NOT EXISTS chat_params (
  id                   TEXT PRIMARY KEY,   -- messageID from OpenCode
  session_id           TEXT NOT NULL,
  timestamp            INTEGER NOT NULL,   -- Unix ms
  model_id             TEXT NOT NULL,
  provider_id          TEXT NOT NULL,
  agent                TEXT,
  -- LLM call parameters
  temperature          REAL,
  top_p                REAL,
  top_k                REAL,
  max_output_tokens    INTEGER,
  -- Model limits at call time (from Model.limit)
  model_context_limit  INTEGER,
  model_output_limit   INTEGER,
  -- Model cost rates at call time (USD per token)
  cost_input           REAL,
  cost_output          REAL,
  cost_cache_read      REAL,
  cost_cache_write     REAL,
  -- Any extra provider options serialised as JSON
  options_json         TEXT
);

-- ─── System prompt snapshots (deduplicated per session+content) ──────────────
-- Captured via experimental.chat.system.transform.

CREATE TABLE IF NOT EXISTS system_prompts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  timestamp      INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,   -- SHA-256 hex of joined system strings
  content        TEXT NOT NULL,   -- Full concatenated system prompt
  token_count    INTEGER,         -- Estimated via char-ratio tokeniser
  UNIQUE (session_id, content_hash)
);

-- ─── Context window composition per assistant turn ───────────────────────────
-- Captured via experimental.chat.messages.transform.

CREATE TABLE IF NOT EXISTS context_snapshots (
  id                       TEXT PRIMARY KEY,   -- messageID
  session_id               TEXT NOT NULL,
  timestamp                INTEGER NOT NULL,
  -- Message / part counts
  message_count            INTEGER NOT NULL,
  total_parts              INTEGER NOT NULL,
  tool_parts               INTEGER NOT NULL,
  text_parts               INTEGER NOT NULL,
  -- Token estimates (derived from char-ratio per part)
  estimated_tokens         INTEGER,
  context_utilization      REAL,   -- estimated / model_context_limit (may exceed 1.0)
  -- Composition percentages (0.0–1.0)
  system_token_pct         REAL,
  tool_output_token_pct    REAL,
  conversation_token_pct   REAL
);

-- ─── Full tool call data (input + output + timing) ───────────────────────────
-- Row created in tool.execute.before, completed in tool.execute.after.

CREATE TABLE IF NOT EXISTS tool_calls (
  id                       TEXT PRIMARY KEY,   -- callID from OpenCode
  session_id               TEXT NOT NULL,
  message_id               TEXT NOT NULL,
  tool                     TEXT NOT NULL,
  -- Timing
  timestamp_start          INTEGER,            -- Unix ms
  timestamp_end            INTEGER,            -- Unix ms
  duration_ms              INTEGER,
  -- Outcome
  status                   TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | error
  -- Full input/output
  input_json               TEXT NOT NULL DEFAULT '{}',
  input_size_bytes         INTEGER,
  input_estimated_tokens   INTEGER,
  output_text              TEXT,
  output_compressed        INTEGER NOT NULL DEFAULT 0,   -- 1 = gzipped
  output_size_bytes        INTEGER,
  output_estimated_tokens  INTEGER,
  -- Metadata
  title                    TEXT,
  truncated                INTEGER NOT NULL DEFAULT 0,   -- 1 = OpenCode truncated output
  error_text               TEXT,
  -- Cost allocation (computed when the parent step-finish fires)
  next_turn_token_impact   INTEGER,  -- estimated tokens this output will cost as input next turn
  cost_share               REAL      -- proportional share of step-finish cost (approx, ~)
);

-- ─── Per-step token data (from StepFinishPart SSE events) ────────────────────

CREATE TABLE IF NOT EXISTS step_metrics (
  id                   TEXT PRIMARY KEY,   -- StepFinishPart.id
  session_id           TEXT NOT NULL,
  message_id           TEXT NOT NULL,
  timestamp            INTEGER NOT NULL,
  reason               TEXT NOT NULL,      -- tool-calls | stop | error | length | …
  cost                 REAL NOT NULL DEFAULT 0,
  tokens_input         INTEGER NOT NULL DEFAULT 0,
  tokens_output        INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning     INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read    INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write   INTEGER NOT NULL DEFAULT 0
);

-- ─── Streaming timing per assistant message ───────────────────────────────────

CREATE TABLE IF NOT EXISTS streaming_timing (
  message_id             TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  -- Event milestones (Unix ms, NULL until the event fires)
  request_sent           INTEGER,   -- chat.params called
  first_part_received    INTEGER,   -- first message.part.updated event
  first_text_received    INTEGER,   -- first TextPart event
  first_tool_call        INTEGER,   -- first ToolPart (pending) event
  message_completed      INTEGER,   -- message.updated with finish set
  -- Derived (populated on completion)
  time_to_first_token_ms INTEGER,   -- first_text - request_sent
  total_streaming_ms     INTEGER    -- message_completed - first_part_received
);

-- ─── Multi-approach token estimates for benchmark comparison ─────────────────

CREATE TABLE IF NOT EXISTS token_estimates (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id           TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  approach             TEXT NOT NULL,   -- opencode | char-ratio | model-info
  model_id             TEXT NOT NULL,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cache_read_tokens    INTEGER,
  cache_write_tokens   INTEGER,
  total_tokens         INTEGER,
  estimated_cost       REAL,
  timestamp            INTEGER NOT NULL,
  UNIQUE (message_id, approach)
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_chat_params_session    ON chat_params(session_id);
CREATE INDEX IF NOT EXISTS idx_system_prompts_session ON system_prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_context_session        ON context_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session     ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool        ON tool_calls(tool);
CREATE INDEX IF NOT EXISTS idx_step_metrics_session   ON step_metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_step_metrics_message   ON step_metrics(message_id);
CREATE INDEX IF NOT EXISTS idx_streaming_session      ON streaming_timing(session_id);
CREATE INDEX IF NOT EXISTS idx_token_est_session      ON token_estimates(session_id);
CREATE INDEX IF NOT EXISTS idx_token_est_approach     ON token_estimates(approach);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message     ON tool_calls(message_id);

-- ─── Retrieval relevance scoring (per tool call per message) ─────────────────
-- Populated by src/analysis/relevance.ts after message.updated fires.
-- Measures how much of each tool's output the model actually used.

CREATE TABLE IF NOT EXISTS retrieval_relevance (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL,
  message_id            TEXT NOT NULL,       -- assistant message that consumed the tool output
  tool_call_id          TEXT NOT NULL,       -- FK → tool_calls.id
  tool                  TEXT NOT NULL,
  -- What was fetched
  fetched_tokens        INTEGER NOT NULL,    -- output_estimated_tokens from tool_calls
  fetched_lines         INTEGER,             -- total lines returned (for file reads)
  -- What was referenced in the response
  referenced_tokens     INTEGER,             -- estimated tokens of content the model cited/used
  referenced_lines      INTEGER,             -- lines from the output that appear in the response
  -- Scores
  relevance_ratio       REAL,               -- referenced_tokens / fetched_tokens (0.0–1.0)
  scoring_method        TEXT NOT NULL,       -- 'line-overlap' | 'substring-match'
  timestamp             INTEGER NOT NULL
);

-- ─── Per-phase tool latency breakdown ────────────────────────────────────────
-- One row per phase per tool call. Phase = 'total' for the baseline (no RAG).
-- RAG plugins can add rows with phases like 'embedding', 'vector-search', etc.

CREATE TABLE IF NOT EXISTS tool_latency_breakdown (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_call_id          TEXT NOT NULL,       -- FK → tool_calls.id
  session_id            TEXT NOT NULL,
  phase                 TEXT NOT NULL,       -- 'embedding' | 'vector-search' | 'file-io' | 'network' | 'total'
  duration_ms           INTEGER NOT NULL,
  metadata_json         TEXT,               -- optional: chunk count, index size, etc.
  timestamp             INTEGER NOT NULL
);

-- ─── Benchmark task registry ──────────────────────────────────────────────────
-- Defines repeatable tasks for A/B comparison between retrieval strategies.

CREATE TABLE IF NOT EXISTS benchmark_tasks (
  id                    TEXT PRIMARY KEY,    -- user-defined task ID (e.g. 'find-client-errors')
  description           TEXT NOT NULL,
  expected_output_hint  TEXT,               -- optional: substring a correct answer must contain
  created_at            INTEGER NOT NULL
);

-- ─── Benchmark run results ────────────────────────────────────────────────────
-- One row per (task, session, strategy). Aggregated after the session ends.

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id               TEXT NOT NULL,       -- FK → benchmark_tasks.id
  session_id            TEXT NOT NULL,
  strategy              TEXT NOT NULL,       -- 'full-file' | 'rag-chunk' | 'hybrid'
  -- Token / cost aggregates
  total_input_tokens    INTEGER,
  total_output_tokens   INTEGER,
  total_cost            REAL,
  total_tool_calls      INTEGER,
  total_fetched_tokens  INTEGER,             -- SUM of tool output tokens fed into context
  total_referenced_tokens INTEGER,           -- SUM of tokens the model actually used
  -- Quality scores
  precision_score       REAL,               -- total_referenced / total_fetched (0.0–1.0)
  avg_relevance         REAL,               -- AVG of retrieval_relevance.relevance_ratio
  -- Speed metrics
  avg_ttft_ms           INTEGER,            -- AVG time-to-first-token across all messages
  avg_tool_duration_ms  INTEGER,            -- AVG tool_calls.duration_ms
  total_session_ms      INTEGER,            -- wall-clock from first request_sent to last message_completed
  -- Query performance
  avg_query_ms          INTEGER,            -- AVG latency of DB/retrieval queries (from tool_latency_breakdown phase='total')
  p50_query_ms          INTEGER,            -- p50 query latency
  p95_query_ms          INTEGER,            -- p95 query latency
  timestamp             INTEGER NOT NULL
);

-- ─── Indexes for new tables ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_relevance_session    ON retrieval_relevance(session_id);
CREATE INDEX IF NOT EXISTS idx_relevance_message    ON retrieval_relevance(message_id);
CREATE INDEX IF NOT EXISTS idx_relevance_tool_call  ON retrieval_relevance(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_latency_tool_call    ON tool_latency_breakdown(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_latency_session      ON tool_latency_breakdown(session_id);
CREATE INDEX IF NOT EXISTS idx_bench_runs_task      ON benchmark_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_bench_runs_session   ON benchmark_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_bench_runs_strategy  ON benchmark_runs(strategy);

-- ─── Migrations (safe: ALTER TABLE ADD COLUMN is idempotent on SQLite 3.37+) ─

`;

/**
 * Migration statements to run against existing v1 databases.
 * Each is wrapped in a try/catch in connection.ts — duplicate column errors are ignored.
 */
export const MIGRATIONS: string[] = [
  // v1 → v2: add cost-allocation columns to tool_calls
  `ALTER TABLE tool_calls ADD COLUMN next_turn_token_impact INTEGER`,
  `ALTER TABLE tool_calls ADD COLUMN cost_share REAL`,
  // v2 → v3: new benchmark / RAG tables (CREATE TABLE IF NOT EXISTS — safe to re-run)
  // These are already in the DDL above for fresh installs; migrations run for existing DBs.
  `CREATE TABLE IF NOT EXISTS retrieval_relevance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL, message_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
    tool TEXT NOT NULL, fetched_tokens INTEGER NOT NULL, fetched_lines INTEGER,
    referenced_tokens INTEGER, referenced_lines INTEGER,
    relevance_ratio REAL, scoring_method TEXT NOT NULL, timestamp INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tool_latency_breakdown (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_call_id TEXT NOT NULL, session_id TEXT NOT NULL, phase TEXT NOT NULL,
    duration_ms INTEGER NOT NULL, metadata_json TEXT, timestamp INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS benchmark_tasks (
    id TEXT PRIMARY KEY, description TEXT NOT NULL,
    expected_output_hint TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS benchmark_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL, session_id TEXT NOT NULL, strategy TEXT NOT NULL,
    total_input_tokens INTEGER, total_output_tokens INTEGER, total_cost REAL,
    total_tool_calls INTEGER, total_fetched_tokens INTEGER, total_referenced_tokens INTEGER,
    precision_score REAL, avg_relevance REAL,
    avg_ttft_ms INTEGER, avg_tool_duration_ms INTEGER, total_session_ms INTEGER,
    avg_query_ms INTEGER, p50_query_ms INTEGER, p95_query_ms INTEGER,
    timestamp INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_relevance_session   ON retrieval_relevance(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_relevance_message   ON retrieval_relevance(message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_relevance_tool_call ON retrieval_relevance(tool_call_id)`,
  `CREATE INDEX IF NOT EXISTS idx_latency_tool_call   ON tool_latency_breakdown(tool_call_id)`,
  `CREATE INDEX IF NOT EXISTS idx_latency_session     ON tool_latency_breakdown(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bench_runs_task     ON benchmark_runs(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bench_runs_session  ON benchmark_runs(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bench_runs_strategy ON benchmark_runs(strategy)`,
];
