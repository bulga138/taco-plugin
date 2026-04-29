/**
 * Relevance scoring engine.
 *
 * Measures how much of each tool call's output was actually referenced
 * in the assistant's final text response. Two offline methods:
 *
 *   'line-overlap'     — split both texts into non-empty lines; count how
 *                        many output lines appear (verbatim, trimmed) in the
 *                        response. Fast and precise for read/grep outputs.
 *
 *   'substring-match'  — extract identifiers, file paths, and code tokens
 *                        from the response; check how many appear in the
 *                        tool output. Better for structured JSON/code outputs.
 *
 * Both methods run offline (no LLM call) against data already in the DB.
 * Errors are caught and swallowed — the plugin must never crash OpenCode.
 */

import { getPluginDb } from '../db/connection.js';
import { writeRetrievalRelevance } from '../db/writers.js';
import { estimateTokens } from '../tokenizer/index.js';
import { maybeDecompress } from '../utils/compress.js';

// ─── Internal types ───────────────────────────────────────────────────────────

interface ToolCallRecord {
  id: string;
  tool: string;
  output_text: string | null;
  output_compressed: number;
  output_estimated_tokens: number | null;
  fetched_lines: number | null;
}

interface LineOverlapResult {
  referencedLines: number;
  fetchedLines: number;
  referencedTokens: number;
  relevanceRatio: number;
}

interface SubstringMatchResult {
  referencedTokens: number;
  fetchedTokens: number;
  relevanceRatio: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Split text into trimmed, non-empty lines. */
function toLines(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

/**
 * Extract identifiers, file paths, and quoted strings from text.
 * Used by the substring-match method.
 */
function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();

  // Quoted strings (single or double, 4+ chars)
  for (const m of text.matchAll(/["']([^"']{4,}?)["']/g)) {
    tokens.add(m[1].trim());
  }

  // File paths (anything with / or . followed by an extension)
  for (const m of text.matchAll(/\b([\w./-]{4,}\.(?:ts|js|py|go|rs|md|json|yaml|yml|sh))\b/g)) {
    tokens.add(m[1]);
  }

  // camelCase / PascalCase / snake_case identifiers (6+ chars to reduce noise)
  for (const m of text.matchAll(/\b([a-zA-Z][a-zA-Z0-9_]{5,})\b/g)) {
    tokens.add(m[1]);
  }

  return tokens;
}

// ─── Scoring methods ──────────────────────────────────────────────────────────

/**
 * Line-overlap scoring.
 * Best for: read, grep, glob, find outputs where the model quotes lines.
 */
export function scoreLineOverlap(outputText: string, responseText: string, modelId = ''): LineOverlapResult {
  const outputLines = toLines(outputText);
  const responseSet = new Set(toLines(responseText));

  const fetchedLines = outputLines.length;
  let referencedLines = 0;
  let referencedChars = 0;

  for (const line of outputLines) {
    if (line.length < 4) continue; // skip trivial lines
    if (responseSet.has(line) || responseText.includes(line)) {
      referencedLines++;
      referencedChars += line.length;
    }
  }

  const referencedTokens = estimateTokens(outputLines.filter((_, i) => i < referencedLines).join('\n'), modelId).count;

  const fetchedTokens = estimateTokens(outputText, modelId).count;
  const relevanceRatio = fetchedTokens > 0 ? Math.min(1, referencedTokens / fetchedTokens) : 0;

  return { referencedLines, fetchedLines, referencedTokens, relevanceRatio };
}

/**
 * Substring-match scoring.
 * Best for: structured/JSON/code outputs where the model paraphrases rather than quotes.
 */
export function scoreSubstringMatch(outputText: string, responseText: string, modelId = ''): SubstringMatchResult {
  const outputTokens = extractTokens(outputText);
  const fetchedTokens = estimateTokens(outputText, modelId).count;

  if (outputTokens.size === 0 || fetchedTokens === 0) {
    return { referencedTokens: 0, fetchedTokens, relevanceRatio: 0 };
  }

  let matchedChars = 0;
  for (const token of outputTokens) {
    if (responseText.includes(token)) {
      matchedChars += token.length;
    }
  }

  const totalExtractedChars = [...outputTokens].reduce((s, t) => s + t.length, 0);
  const matchRatio = totalExtractedChars > 0 ? matchedChars / totalExtractedChars : 0;
  const referencedTokens = Math.round(fetchedTokens * matchRatio);
  const relevanceRatio = Math.min(1, matchRatio);

  return { referencedTokens, fetchedTokens, relevanceRatio };
}

// ─── Main entry point: score all tool calls for a finished message ────────────

/**
 * Called after `message.updated` fires with a finish reason.
 * Reads all tool_calls for the message from the DB, scores each against
 * the assistant's response text, and writes rows to retrieval_relevance.
 *
 * Never throws — all errors are caught and logged quietly.
 */
export function scoreMessageToolCalls(messageId: string, sessionId: string, responseText: string, modelId = ''): void {
  try {
    const db = getPluginDb();

    const calls = db
      .query<ToolCallRecord, [string]>(
        `SELECT id, tool, output_text, output_compressed, output_estimated_tokens, NULL AS fetched_lines
         FROM tool_calls
         WHERE message_id = ? AND status = 'completed' AND output_text IS NOT NULL`,
      )
      .all(messageId);

    if (calls.length === 0) return;

    const now = Date.now();

    for (const call of calls) {
      try {
        const rawOutput = maybeDecompress(call.output_text ?? '', call.output_compressed === 1);
        if (!rawOutput) continue;

        const fetchedTokens = call.output_estimated_tokens ?? estimateTokens(rawOutput, modelId).count;
        const outputLines = toLines(rawOutput);
        const fetchedLines = outputLines.length;

        // Choose method based on tool name:
        //   file-read tools  → line-overlap (they return file contents verbatim)
        //   everything else  → substring-match
        const isFileRead = /^(read|cat|serena_read_file|view|open)$/i.test(call.tool);

        if (isFileRead) {
          const result = scoreLineOverlap(rawOutput, responseText, modelId);
          writeRetrievalRelevance({
            sessionId,
            messageId,
            toolCallId: call.id,
            tool: call.tool,
            fetchedTokens,
            fetchedLines,
            referencedTokens: result.referencedTokens,
            referencedLines: result.referencedLines,
            relevanceRatio: result.relevanceRatio,
            scoringMethod: 'line-overlap',
            timestamp: now,
          });
        } else {
          const result = scoreSubstringMatch(rawOutput, responseText, modelId);
          writeRetrievalRelevance({
            sessionId,
            messageId,
            toolCallId: call.id,
            tool: call.tool,
            fetchedTokens,
            fetchedLines,
            referencedTokens: result.referencedTokens,
            referencedLines: null,
            relevanceRatio: result.relevanceRatio,
            scoringMethod: 'substring-match',
            timestamp: now,
          });
        }
      } catch (innerErr) {
        console.error('[taco-plugin] relevance scoring (inner):', (innerErr as Error).message);
      }
    }
  } catch (err) {
    console.error('[taco-plugin] scoreMessageToolCalls error:', (err as Error).message);
  }
}
