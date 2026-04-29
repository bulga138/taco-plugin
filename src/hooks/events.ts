/**
 * event hook — processes the SSE event stream from OpenCode.
 *
 * CONCURRENCY SAFETY:
 * All session tracking is keyed by sessionId, not just messageId.
 * On session.idle, the session's Sets are cleaned up to prevent memory leaks.
 * All DB writes are queueMicrotask — never blocking.
 */

import type { Hooks } from '@opencode-ai/plugin';
import type { Event } from '@opencode-ai/sdk';
import {
  writeStepMetrics,
  writeStreamingTimingStart,
  updateStreamingField,
  writeTokenEstimate,
  updateToolCallCostShares,
} from '../db/writers.js';
import { scoreMessageToolCalls } from '../analysis/relevance.js';

// ─── Session-scoped dedup sets ────────────────────────────────────────────────
// Outer key = sessionId, inner Set = messageIds already seen.
// Cleaned up on session.idle to prevent unbounded growth.

const _seenFirstPart = new Map<string, Set<string>>();
const _seenFirstText = new Map<string, Set<string>>();
const _seenFirstTool = new Map<string, Set<string>>();
// Tracks which (sessionId, messageId) pairs have had their streaming_timing row
// seeded so we do it exactly once per assistant message.
const _seenTimingRow = new Map<string, Set<string>>();

function seenFor(map: Map<string, Set<string>>, sessionId: string): Set<string> {
  let s = map.get(sessionId);
  if (!s) {
    s = new Set();
    map.set(sessionId, s);
  }
  return s;
}

function cleanupSession(sessionId: string): void {
  _seenFirstPart.delete(sessionId);
  _seenFirstText.delete(sessionId);
  _seenFirstTool.delete(sessionId);
  _seenTimingRow.delete(sessionId);
}

export function makeEventHook(): NonNullable<Hooks['event']> {
  return async ({ event }: { event: Event }) => {
    try {
      // ── session.idle: clean up per-session Sets to prevent memory leaks ──
      if (event.type === 'session.idle') {
        const sessionId = (event.properties as { sessionID?: string }).sessionID;
        if (sessionId) cleanupSession(sessionId);
        return;
      }

      // ── message.part.updated ─────────────────────────────────────────────
      if (event.type === 'message.part.updated') {
        const part = event.properties.part;
        const messageId = part.messageID;
        const sessionId = part.sessionID;
        const now = Date.now();

        // Seed streaming_timing row on first part for this assistant message.
        // This is the correct place to create the row because messageID here
        // is the ASSISTANT message ID — chat.params only has the user message ID.
        const seenTiming = seenFor(_seenTimingRow, sessionId);
        if (!seenTiming.has(messageId)) {
          seenTiming.add(messageId);
          queueMicrotask(() => writeStreamingTimingStart(messageId, sessionId, now));
        }

        // First part received (any type) — session-scoped dedup
        const seenPart = seenFor(_seenFirstPart, sessionId);
        if (!seenPart.has(messageId)) {
          seenPart.add(messageId);
          queueMicrotask(() => updateStreamingField(messageId, 'first_part_received', now));
        }

        if (part.type === 'text') {
          const seenText = seenFor(_seenFirstText, sessionId);
          if (!seenText.has(messageId)) {
            seenText.add(messageId);
            queueMicrotask(() => updateStreamingField(messageId, 'first_text_received', now));
          }
          return;
        }

        if (part.type === 'tool') {
          const state = (part as { state?: { status?: string } }).state;
          if (state?.status === 'pending') {
            const seenTool = seenFor(_seenFirstTool, sessionId);
            if (!seenTool.has(messageId)) {
              seenTool.add(messageId);
              queueMicrotask(() => updateStreamingField(messageId, 'first_tool_call', now));
            }
          }
          return;
        }

        if (part.type === 'step-finish') {
          const sf = part as {
            id: string;
            sessionID: string;
            messageID: string;
            reason: string;
            cost: number;
            tokens: {
              input: number;
              output: number;
              reasoning: number;
              cache: { read: number; write: number };
            };
          };

          queueMicrotask(() => {
            writeStepMetrics({
              id: sf.id,
              sessionId: sf.sessionID,
              messageId: sf.messageID,
              timestamp: now,
              reason: sf.reason,
              cost: sf.cost,
              tokensInput: sf.tokens.input,
              tokensOutput: sf.tokens.output,
              tokensReasoning: sf.tokens.reasoning,
              tokensCacheRead: sf.tokens.cache.read,
              tokensCacheWrite: sf.tokens.cache.write,
            });

            // Allocate proportional cost shares to tool_calls in this message
            if (sf.cost > 0) {
              updateToolCallCostShares(sf.messageID, sf.cost);
            }
          });
        }

        return;
      }

      // ── message.updated (finish) ─────────────────────────────────────────
      if (event.type === 'message.updated') {
        const info = event.properties.info;
        if (info.role !== 'assistant') return;

        const msg = info as {
          id: string;
          sessionID: string;
          role: 'assistant';
          finish?: string;
          cost: number;
          tokens: {
            input: number;
            output: number;
            reasoning: number;
            cache: { read: number; write: number };
          };
          modelID: string;
        };

        if (!msg.finish) return;

        const now = Date.now();

        queueMicrotask(() => updateStreamingField(msg.id, 'message_completed', now));

        // Ground-truth token estimate (approach = "opencode")
        queueMicrotask(() => {
          const total =
            msg.tokens.input +
            msg.tokens.output +
            msg.tokens.reasoning +
            msg.tokens.cache.read +
            msg.tokens.cache.write;

          writeTokenEstimate({
            messageId: msg.id,
            sessionId: msg.sessionID,
            approach: 'opencode',
            modelId: msg.modelID,
            inputTokens: msg.tokens.input,
            outputTokens: msg.tokens.output,
            cacheReadTokens: msg.tokens.cache.read,
            cacheWriteTokens: msg.tokens.cache.write,
            totalTokens: total,
            estimatedCost: msg.cost,
            timestamp: now,
          });
        });

        // Relevance scoring — runs offline against data already in the DB.
        // Extract the assistant's text response from the event's finish info,
        // then score each completed tool call for this message.
        queueMicrotask(() => {
          try {
            // The message.updated event carries a `parts` array on some SDK
            // versions; fall back to an empty string if unavailable.
            const parts = (msg as unknown as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
            const responseText = parts
              .filter(p => p.type === 'text')
              .map(p => p.text ?? '')
              .join('\n');

            if (responseText.trim()) {
              scoreMessageToolCalls(msg.id, msg.sessionID, responseText, msg.modelID);
            }
          } catch {
            /* non-critical */
          }
        });
      }
    } catch (err) {
      console.error('[taco-plugin] event hook error:', (err as Error).message);
    }
  };
}
