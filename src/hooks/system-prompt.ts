/**
 * System-prompt capture — called from the session "context" hook.
 *
 * CONCURRENCY SAFETY: All data derived from input parameters — no shared state.
 * Deduplication handled by the DB UNIQUE(session_id, content_hash) constraint.
 */

import { writeSystemPrompt } from '../db/writers.js'
import { estimateTokens } from '../tokenizer/index.js'
import { sha256hex } from '../utils/hash.js'

export function captureSystemPrompt(
  sessionId: string,
  modelId: string,
  parts: ReadonlyArray<{ type: string; text: string }>,
): void {
  const content = parts.map(p => p.text).join('\n\n')
  if (!content) return

  const contentHash = sha256hex(content)
  const tokenCount = estimateTokens(content, modelId).count

  queueMicrotask(() => {
    writeSystemPrompt({
      sessionId,
      modelId,
      timestamp: Date.now(),
      contentHash,
      content,
      tokenCount,
    })
  })
}
