/**
 * experimental.chat.system.transform hook — captures the full system prompt.
 *
 * CONCURRENCY SAFETY: All data derived from input parameters — no shared state.
 * Deduplication handled by the DB UNIQUE(session_id, content_hash) constraint.
 */

import type { Hooks } from '@opencode-ai/plugin'
import { writeSystemPrompt } from '../db/writers.js'
import { estimateTokens } from '../tokenizer/index.js'
import { sha256hex } from '../utils/hash.js'

type SystemTransformInput  = Parameters<NonNullable<Hooks['experimental.chat.system.transform']>>[0]
type SystemTransformOutput = Parameters<NonNullable<Hooks['experimental.chat.system.transform']>>[1]

export function makeSystemPromptHook(): NonNullable<Hooks['experimental.chat.system.transform']> {
  return async (input: SystemTransformInput, output: SystemTransformOutput) => {
    const content = output.system.join('\n\n')
    if (!content) return

    const sessionId   = input.sessionID ?? ''
    const modelId     = (input.model as { id?: string }).id ?? 'unknown'
    const contentHash = sha256hex(content)
    const tokenCount  = estimateTokens(content, modelId).count

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
}