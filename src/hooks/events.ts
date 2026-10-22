/**
 * Event stream handler — processes the OpenCode V2 event stream.
 *
 * CONCURRENCY SAFETY:
 * All session tracking is keyed by sessionId, not just messageId.
 * On session.idle, the session's Sets are cleaned up to prevent memory leaks.
 * All DB writes are queueMicrotask — never blocking.
 */

import {
  writeStepMetrics,
  writeStreamingTimingStart,
  updateStreamingField,
  writeTokenEstimate,
  updateToolCallCostShares,
} from '../db/writers.js';
import { scoreMessageToolCalls } from '../analysis/relevance.js';

// ─── Minimal structural event type ────────────────────────────────────────────
// Matches the subset of the V2 event envelope the plugin consumes.

export interface V2EventLike {
  readonly id?: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

// ─── Session-scoped dedup sets ────────────────────────────────────────────────
// Outer key = sessionId, inner Set = messageIds already seen.
// Cleaned up on session.idle to prevent unbounded growth.
// Max tracked sessions: once this limit is exceeded the oldest session is evicted.

const MAX_TRACKED_SESSIONS = 50;

const _seenFirstPart = new Map<string, Set<string>>();
const _seenFirstText = new Map<string, Set<string>>();
const _seenFirstTool = new Map<string, Set<string>>();
// Assistant message text collected from session.text.ended, consumed by
// session.step.ended for relevance scoring.
const _responseTexts = new Map<string, string>();

function seenFor(map: Map<string, Set<string>>, sessionId: string): Set<string> {
  let s = map.get(sessionId);
  if (!s) {
    // Evict oldest entry if at capacity
    if (map.size >= MAX_TRACKED_SESSIONS) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) map.delete(oldestKey);
    }
    s = new Set();
    map.set(sessionId, s);
  }
  return s;
}

function cleanupSession(sessionId: string): void {
  _seenFirstPart.delete(sessionId);
  _seenFirstText.delete(sessionId);
  _seenFirstTool.delete(sessionId);
}

export function makeEventHandler(modelCache: Map<string, string>) {
  return (event: V2EventLike): void => {
    try {
      const data = (event.data ?? {}) as Record<string, unknown>;

      // ── session.idle: clean up per-session Sets to prevent memory leaks ──
      if (event.type === 'session.idle') {
        const sessionId = data.sessionID as string | undefined;
        if (sessionId) cleanupSession(sessionId);
        return;
      }

      // ── session.step.started: seed timing row + first_part_received ──────
      if (event.type === 'session.step.started') {
        const sessionId = data.sessionID as string;
        const messageId = data.assistantMessageID as string;
        const now = Date.now();

        const seenPart = seenFor(_seenFirstPart, sessionId);
        if (!seenPart.has(messageId)) {
          seenPart.add(messageId);
          queueMicrotask(() => writeStreamingTimingStart(messageId, sessionId, now));
          queueMicrotask(() => updateStreamingField(messageId, 'first_part_received', now));
        }
        return;
      }

      // ── session.text.started: first_text_received ─────────────────────────
      if (event.type === 'session.text.started') {
        const sessionId = data.sessionID as string;
        const messageId = data.assistantMessageID as string;
        const seenText = seenFor(_seenFirstText, sessionId);
        if (!seenText.has(messageId)) {
          seenText.add(messageId);
          queueMicrotask(() => updateStreamingField(messageId, 'first_text_received', Date.now()));
        }
        return;
      }

      // ── session.text.ended: stash text for relevance scoring ─────────────
      if (event.type === 'session.text.ended') {
        const messageId = data.assistantMessageID as string;
        const text = data.text as string | undefined;
        if (text?.trim()) _responseTexts.set(messageId, text);
        return;
      }

      // ── session.tool.input.started: first_tool_call ──────────────────────
      if (event.type === 'session.tool.input.started') {
        const sessionId = data.sessionID as string;
        const messageId = data.assistantMessageID as string;
        const seenTool = seenFor(_seenFirstTool, sessionId);
        if (!seenTool.has(messageId)) {
          seenTool.add(messageId);
          queueMicrotask(() => updateStreamingField(messageId, 'first_tool_call', Date.now()));
        }
        return;
      }

      // ── session.step.ended: step metrics + cost shares + token estimate ──
      if (event.type === 'session.step.ended') {
        const sessionId = data.sessionID as string;
        const messageId = data.assistantMessageID as string;
        const finish = data.finish as string;
        const cost = (data.cost as number) ?? 0;
        const tokens = (data.tokens ?? {}) as {
          input?: number;
          output?: number;
          reasoning?: number;
          cache?: { read?: number; write?: number };
        };
        const now = Date.now();
        const stepId = event.id ?? `${sessionId}:${now}`;

        const modelId = modelCache.get(sessionId) ?? '';
        const responseText = _responseTexts.get(messageId) ?? '';
        _responseTexts.delete(messageId);

        queueMicrotask(() => {
          writeStepMetrics({
            id: stepId,
            sessionId,
            messageId,
            timestamp: now,
            reason: finish,
            cost,
            tokensInput: tokens.input ?? 0,
            tokensOutput: tokens.output ?? 0,
            tokensReasoning: tokens.reasoning ?? 0,
            tokensCacheRead: tokens.cache?.read ?? 0,
            tokensCacheWrite: tokens.cache?.write ?? 0,
          });

          updateStreamingField(messageId, 'message_completed', now);

          // Ground-truth token estimate (approach = "opencode")
          const total =
            (tokens.input ?? 0) +
            (tokens.output ?? 0) +
            (tokens.reasoning ?? 0) +
            (tokens.cache?.read ?? 0) +
            (tokens.cache?.write ?? 0);
          writeTokenEstimate({
            messageId,
            sessionId,
            approach: 'opencode',
            modelId,
            inputTokens: tokens.input ?? 0,
            outputTokens: tokens.output ?? 0,
            cacheReadTokens: tokens.cache?.read ?? 0,
            cacheWriteTokens: tokens.cache?.write ?? 0,
            totalTokens: total,
            estimatedCost: cost,
            timestamp: now,
          });

          // Allocate proportional cost shares to tool_calls in this message
          if (cost > 0) {
            updateToolCallCostShares(messageId, cost);
          }
        });

        // Relevance scoring — runs offline against data already in the DB.
        // Uses setTimeout to yield to other I/O since scoring involves
        // tokenizing potentially large tool outputs.
        if (responseText.trim()) {
          setTimeout(() => {
            try {
              scoreMessageToolCalls(messageId, sessionId, responseText, modelId);
            } catch {
              /* non-critical */
            }
          }, 0);
        }
      }
    } catch (err) {
      console.error('[taco-plugin] event handler error:', (err as Error).message);
    }
  };
}
