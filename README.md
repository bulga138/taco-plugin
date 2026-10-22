# taco-plugin

OpenCode plugin that captures raw telemetry for TACO benchmarking.

Captures per-turn, per-tool, and per-step metrics into a SQLite database. TACO CLI reads this database to show cache efficiency, tool I/O detail, retrieval relevance, latency breakdowns, and benchmark comparisons.

Zero configuration — runs entirely on Bun built-ins.

> Requires OpenCode V2 (>= 2.0). V1 hook API is no longer supported.

## Usage

Register in `opencode.json`:

```json
{ "plugins": ["@bulga138/taco-plugin"] }
```

Or from a local path during development:

```json
{ "plugins": ["/path/to/taco-plugin"] }
```

Then run:

```bash
bun install && bun run build
```

## Hooks

The plugin registers 3 OpenCode V2 hook surfaces:

| Hook (V2)                             | Fires When                  | Writes To                                                 |
| ------------------------------------- | --------------------------- | --------------------------------------------------------- |
| `session.hook("context")`             | Before each model request   | `chat_params`, `token_estimates`, `system_prompts`, `context_snapshots` |
| `tool.hook("execute.before")`         | Tool call starts            | `tool_calls` (partial)                                    |
| `tool.hook("execute.after")`          | Tool call completes         | `tool_calls` (update), `tool_latency_breakdown`           |
| `event.subscribe()` stream            | `session.*` events          | `step_metrics`, `streaming_timing`, `retrieval_relevance` |

## Database

Location: `~/.local/share/taco/plugin.db`

Uses WAL mode for concurrent reads from TACO CLI while the plugin writes.

### Schema (12 tables)

- `meta` — schema version tracking
- `chat_params` — LLM request params per turn
- `system_prompts` — deduplicated system prompt snapshots
- `context_snapshots` — context window composition per turn
- `tool_calls` — full tool call data (input/output/timing)
- `step_metrics` — per-step token data from SSE events
- `streaming_timing` — streaming latency milestones
- `token_estimates` — multi-approach token estimates
- `retrieval_relevance` — how much tool output the model used
- `tool_latency_breakdown` — per-phase latency for tool calls
- `benchmark_tasks` — benchmark task definitions
- `benchmark_runs` — aggregated results per (task, session, strategy)

## Tokenizers

Priority-based token counting:

| Model                     | Package                        | Accuracy   |
| ------------------------- | ------------------------------ | ---------- |
| OpenAI (GPT-4o, o-series) | `gpt-tokenizer`                | Exact      |
| Claude                    | `@lenml/tokenizer-claude`      | Near-exact |
| DeepSeek                  | `@lenml/tokenizer-deepseek_v3` | Near-exact |
| Everything else           | Byte-ratio fallback (~3.8)     | Heuristic  |

Returns `{ count, method, warning? }` for honest UI.

## Commands

```bash
bun run build      # Compile TypeScript
bun test         # Run tests
bun run typecheck # Check types
```

## Dependencies

Runtime:

- `gpt-tokenizer` — exact for OpenAI models
- `@lenml/tokenizer-claude` — near-exact for Claude
- `@lenml/tokenizer-deepseek_v3` — near-exact for DeepSeek

Peer: `@opencode-ai/plugin >= 1.14.29`

## License

MIT
