# taco-plugin

OpenCode plugin that captures raw telemetry for TACO benchmarking.

Captures per-turn, per-tool, and per-step metrics into a SQLite database. TACO CLI reads this database to show cache efficiency, tool I/O detail, retrieval relevance, latency breakdowns, and benchmark comparisons.

Zero configuration — runs entirely on Bun built-ins.

## Usage

Register in `opencode.json`:

```json
{ "plugin": ["taco-plugin"] }
```

Or from a local path during development:

```json
{ "plugin": ["/path/to/taco-plugin"] }
```

Then run:

```bash
bun install && bun run build
```

## Hooks

The plugin registers 6 OpenCode hooks:

| Hook                                   | Fires When               | Writes To                                                 |
| -------------------------------------- | ------------------------ | --------------------------------------------------------- |
| `chat.params`                          | Before each LLM request  | `chat_params`, `token_estimates`                          |
| `experimental.chat.system.transform`   | System prompt assembled  | `system_prompts`                                          |
| `experimental.chat.messages.transform` | Context window assembled | `context_snapshots`                                       |
| `tool.execute.before`                  | Tool call starts         | `tool_calls` (partial)                                    |
| `tool.execute.after`                   | Tool call completes      | `tool_calls` (update), `tool_latency_breakdown`           |
| `event`                                | SSE stream events        | `step_metrics`, `streaming_timing`, `retrieval_relevance` |

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
