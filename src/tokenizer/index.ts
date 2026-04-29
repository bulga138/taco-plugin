/**
 * Token estimation with multiple accuracy levels.
 *
 * Priority:
 * 1. gpt-tokenizer — exact for OpenAI models (GPT-4o, o-series, etc.)
 * 2. @lenml/tokenizer-claude — near-exact for Claude
 * 3. @lenml/tokenizer-deepseek_v3 — near-exact for DeepSeek
 * 4. Byte-ratio fallback — last resort for everything else
 *
 * The function returns a result object with method/warning for honest UIs.
 * No network calls at runtime — all tokenizers load from bundled vocab JSON.
 */

import { encode as encodeOpenAI } from 'gpt-tokenizer'
import { fromPreTrained as getClaudeTokenizer } from '@lenml/tokenizer-claude'
import { fromPreTrained as getDeepSeekTokenizer } from '@lenml/tokenizer-deepseek_v3'

type ClaudeTokenizer = Awaited<ReturnType<typeof getClaudeTokenizer>>
type DeepSeekTokenizer = Awaited<ReturnType<typeof getDeepSeekTokenizer>>

// ─── Lazy singletons — these load vocab data, init once only ─────────────────

let _claude: ClaudeTokenizer | null = null
let _deepseek: DeepSeekTokenizer | null = null

function getClaude(): ClaudeTokenizer {
  if (!_claude) _claude = getClaudeTokenizer()
  return _claude
}

function getDeepSeek(): DeepSeekTokenizer {
  if (!_deepseek) _deepseek = getDeepSeekTokenizer()
  return _deepseek
}

// ─── Model family detection ──────────────────────────────────────────────────

function isOpenAI(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return /^(gpt|openai|^o[1-9])/.test(id)
}

function isClaude(modelId: string): boolean {
  return /claude|anthropic/i.test(modelId)
}

function isDeepSeek(modelId: string): boolean {
  return /deepseek/i.test(modelId)
}

function isClaude47Plus(modelId: string): boolean {
  // Matches claude-4.7, claude-opus-4.7, claude-4-20260701, opus-4.7, etc.
  const match = modelId.match(/claude.*?(\d+)\.(\d+)/i)
  if (!match) return false
  const major = parseInt(match[1], 10)
  const minor = parseInt(match[2], 10)
  return major === 4 && minor >= 7
}

function isGemini(modelId: string): boolean {
  return /gemini/i.test(modelId)
}

function isGLM(modelId: string): boolean {
  return /glm|zhipu/i.test(modelId)
}

function isLlama(modelId: string): boolean {
  return /llama/i.test(modelId)
}

function isQwen(modelId: string): boolean {
  return /qwen|kimi/i.test(modelId)
}

// ─── Byte-ratio fallback — last resort only ───────────────────────────────────

const FALLBACK_RATIOS: [RegExp, number][] = [
  [/claude|anthropic/i, 3.5],
  [/deepseek/i, 3.8],
  [/glm|zhipu/i, 3.8],
  [/llama|mistral/i, 3.8],
  [/qwen|kimi/i, 3.8],
  [/gemini/i, 4.0],
  [/grok/i, 4.0],
]

function countFallback(text: string, modelId: string): number {
  const bytes = new TextEncoder().encode(text).length
  const ratio = FALLBACK_RATIOS.find(([re]) => re.test(modelId))?.[1] ?? 3.8
  return Math.ceil(bytes / ratio)
}

// ─── Main API ────────────────────────────────────────────────────────

export interface TokenCount {
  count: number
  /** How the count was derived */
  method: 'exact' | 'near-exact' | 'heuristic'
  /** Optional warning for borderline cases */
  warning?: string
}

/**
 * Count tokens for a given text and model ID.
 * Returns exact counts where possible, heuristics otherwise.
 */
export function estimateTokens(text: string, modelId: string): TokenCount {
  if (!text) return { count: 0, method: 'exact' }

  // OpenAI — gpt-tokenizer (exact BPE)
  if (isOpenAI(modelId)) {
    return { count: encodeOpenAI(text).length, method: 'exact' }
  }

  // Claude — @lenml (near-exact, handles Claude 2/2.1/2.5/3/3.5/4.x)
  if (isClaude(modelId)) {
    try {
      const count = getClaude().encode(text).length
      const warning = isClaude47Plus(modelId)
        ? 'Claude 4.7+ uses a new tokenizer; count may be slightly low'
        : undefined
      return { count, method: 'near-exact', warning }
    } catch {
      // Fall back to heuristic if tokenizer fails to load
      return { count: countFallback(text, modelId), method: 'heuristic' }
    }
  }

  // DeepSeek V3/R1 — @lenml (near-exact)
  if (isDeepSeek(modelId)) {
    try {
      return { count: getDeepSeek().encode(text).length, method: 'near-exact' }
    } catch {
      return { count: countFallback(text, modelId), method: 'heuristic' }
    }
  }

  // Known families — specific ratio, no warning
  if (isGemini(modelId)) {
    const bytes = new TextEncoder().encode(text).length
    return { count: Math.ceil(bytes / 4.0), method: 'heuristic' }
  }

  if (isGLM(modelId)) {
    return {
      count: countFallback(text, modelId),
      method: 'heuristic',
      warning: 'GLM 5.x tokenizer may differ from ChatGLM3 base vocab',
    }
  }

  if (isLlama(modelId)) {
    const bytes = new TextEncoder().encode(text).length
    return { count: Math.ceil(bytes / 3.8), method: 'heuristic' }
  }

  if (isQwen(modelId)) {
    const bytes = new TextEncoder().encode(text).length
    return { count: Math.ceil(bytes / 3.8), method: 'heuristic' }
  }

  // Unknown — 3.8 default
  return { count: countFallback(text, modelId), method: 'heuristic' }
}

/**
 * Legacy signature for backward compatibility.
 * Uses the default heuristic approach.
 */
export function countTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId).count
}

/**
 * Estimate the cost of a token usage object using provided rates.
 * All rate params are USD per token.
 */
export function estimateCost(opts: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costInput: number
  costOutput: number
  costCacheRead: number
  costCacheWrite: number
}): number {
  return (
    opts.inputTokens * opts.costInput +
    opts.outputTokens * opts.costOutput +
    opts.cacheReadTokens * opts.costCacheRead +
    opts.cacheWriteTokens * opts.costCacheWrite
  )
}