import type { Plugin, Hooks } from '@opencode-ai/plugin';
import { makeSystemPromptHook } from './hooks/system-prompt.js';
import { makeEventHook } from './hooks/events.js';
import { closePluginDb, PLUGIN_DB_PATH, getPluginDb } from './db/connection.js';
import { writeChatParams, writeTokenEstimate } from './db/writers.js';
import { writeContextSnapshot } from './db/writers.js';
import { writeToolCallStart } from './db/writers.js';
import { writeToolCallEnd } from './db/writers.js';
import { writeToolLatencyBreakdown } from './db/writers.js';
import { estimateTokens } from './tokenizer/index.js';
import { maybeCompress } from './utils/compress.js';

export const TacoPlugin: Plugin = async _ctx => {
  console.log(`[taco-plugin] Plugin DB: ${PLUGIN_DB_PATH}`);
  let _exitHandlerRegistered = false;
  function _closeOnce() {
    closePluginDb();
  }
  if (!_exitHandlerRegistered) {
    _exitHandlerRegistered = true;
    process.on('exit', _closeOnce);
    process.on('SIGTERM', _closeOnce);
  }

  // In-memory model cache: sessionId → modelId (populated by chat.params, cleared on session end)
  const _modelCache = new Map<string, string>();

  // In-memory start-time cache: callId → wallStart ms (populated by before, consumed by after)
  const _toolStartTimes = new Map<string, number>();
  const hooks: Hooks = {
    // ── chat.params: all params come directly from input — no shared state ──
    'chat.params': async (input, output) => {
      const messageId = input.message.id;
      const sessionId = input.sessionID;
      const modelId = input.model.id;
      const now = Date.now();
      const modelCost = input.model.cost;
      const modelLimit = input.model.limit;
      const providerId = (input.provider as { info?: { id?: string } })?.info?.id ?? '';
      const optionsJson =
        output.options && Object.keys(output.options).length > 0 ? JSON.stringify(output.options) : null;

      // Cache modelId so tool hooks don't need a DB round-trip
      _modelCache.set(sessionId, modelId);
      queueMicrotask(() => {
        try {
          writeChatParams({
            id: messageId,
            sessionId,
            timestamp: now,
            modelId,
            providerId,
            agent: input.agent,
            temperature: output.temperature,
            topP: output.topP,
            topK: output.topK,
            maxOutputTokens: output.maxOutputTokens ?? null,
            modelContextLimit: modelLimit?.context ?? null,
            modelOutputLimit: modelLimit?.output ?? null,
            costInput: modelCost?.input ?? null,
            costOutput: modelCost?.output ?? null,
            costCacheRead: modelCost?.cache?.read ?? null,
            costCacheWrite: modelCost?.cache?.write ?? null,
            optionsJson,
          });
          writeTokenEstimate({
            messageId,
            sessionId,
            approach: 'char-ratio',
            modelId,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            estimatedCost: 0,
            timestamp: now,
          });
        } catch (err) {
          console.error('[taco-plugin] chat.params microtask error:', (err as Error).message);
        }
      });
    },
    // ── system prompt: sessionID and model come from input ─────────────────
    'experimental.chat.system.transform': makeSystemPromptHook(),
    // ── context window: sessionID from message array, model from DB ─────────
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        const firstMsg = output.messages[0];
        if (!firstMsg) return;
        const sessionId = (firstMsg.info as { sessionID?: string }).sessionID ?? '';
        if (!sessionId) return;
        let contextLimit: number | null = null;
        let modelId = '';
        try {
          const db = getPluginDb();
          const row = db
            .query<{ id: string; model_context_limit: number | null; model_id: string }, [string]>(
              `SELECT id, model_context_limit, model_id FROM chat_params
               WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`,
            )
            .get(sessionId);
          if (!row) return;
          contextLimit = row.model_context_limit;
          modelId = row.model_id;
          // Use the message ID from chat_params as the snapshot key
          const messageId = row.id;

          let toolParts = 0;
          let textParts = 0;
          let totalParts = 0;
          let toolTokens = 0;
          let convTokens = 0;

          for (const { parts } of output.messages) {
            for (const part of parts) {
              totalParts++;
              const p = part as Record<string, unknown>;
              const type = p.type as string | undefined;

              if (type === 'tool') {
                toolParts++;
                const state = p.state as Record<string, unknown> | undefined;
                const outStr = state?.output as string | undefined;
                if (outStr) toolTokens += estimateTokens(outStr, modelId).count;
              } else if (type === 'text') {
                textParts++;
                const text = p.text as string | undefined;
                if (text) convTokens += estimateTokens(text, modelId).count;
              }
            }
          }

          const estimatedTokens = toolTokens + convTokens;
          const contextUtilization = contextLimit && contextLimit > 0 ? estimatedTokens / contextLimit : null;
          const total = estimatedTokens || 1;

          queueMicrotask(() => {
            writeContextSnapshot({
              id: messageId,
              sessionId,
              timestamp: Date.now(),
              messageCount: output.messages.length,
              totalParts,
              toolParts,
              textParts,
              estimatedTokens,
              contextUtilization,
              systemTokenPct: null,
              toolOutputTokenPct: toolTokens / total,
              conversationTokenPct: convTokens / total,
            });
          });
        } catch {
          // DB not yet initialised — skip silently
        }
      } catch (err) {
        console.error('[taco-plugin] context-window hook error:', (err as Error).message);
      }
    },

    // ── tool.execute.before: sessionID from input, modelId via cache ─────
    'tool.execute.before': async (input, output) => {
      const callId = input.callID;
      const sessionId = input.sessionID;
      const tool = input.tool;
      // Capture wall-clock start for latency breakdown (used in after hook)
      const wallStart = Date.now();

      // Store start time in memory — consumed by tool.execute.after to avoid DB race
      _toolStartTimes.set(callId, wallStart);

      // Derive modelId from cache; fall back to DB only if not cached
      let modelId = _modelCache.get(sessionId) ?? '';
      if (!modelId) {
        try {
          const db = getPluginDb();
          const row = db
            .query<
              { model_id: string },
              [string]
            >(`SELECT model_id FROM chat_params WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`)
            .get(sessionId);
          modelId = row?.model_id ?? '';
          if (modelId) _modelCache.set(sessionId, modelId);
        } catch {
          /* ok — modelId stays '' */
        }
      }

      const inputJson = JSON.stringify(output.args);
      const inputBytes = Buffer.byteLength(inputJson, 'utf8');
      const inputToks = estimateTokens(inputJson, modelId).count;

      queueMicrotask(() => {
        writeToolCallStart({
          id: callId,
          sessionId,
          messageId: '', // not available in this hook; enriched from events
          tool,
          timestampStart: wallStart,
          inputJson,
          inputSizeBytes: inputBytes,
          inputEstimatedTokens: inputToks,
        });
      });
    },

    // ── tool.execute.after: sessionID from input, modelId via cache ───────
    'tool.execute.after': async (input, output) => {
      const callId = input.callID;
      const sessionId = input.sessionID;
      const wallEnd = Date.now();

      // Consume start time from memory (set by tool.execute.before)
      const wallStart = _toolStartTimes.get(callId);
      _toolStartTimes.delete(callId);

      let modelId = _modelCache.get(sessionId) ?? '';
      if (!modelId) {
        try {
          const db = getPluginDb();
          const row = db
            .query<
              { model_id: string },
              [string]
            >(`SELECT model_id FROM chat_params WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`)
            .get(sessionId);
          modelId = row?.model_id ?? '';
          if (modelId) _modelCache.set(sessionId, modelId);
        } catch {
          /* ok */
        }
      }

      const rawOutput = output.output ?? '';
      const { data, compressed, sizeBytes } = maybeCompress(rawOutput);
      const outputToks = estimateTokens(rawOutput, modelId).count;
      // next_turn_token_impact: how many tokens this result will consume as input next turn
      const nextTurnImpact = outputToks;

      const meta = output.metadata as Record<string, unknown> | null | undefined;
      const truncated = meta?.truncated === true;

      queueMicrotask(() => {
        writeToolCallEnd({
          id: callId,
          timestampEnd: wallEnd,
          status: 'completed',
          outputText: data,
          outputCompressed: compressed,
          outputSizeBytes: sizeBytes,
          outputEstimatedTokens: outputToks,
          nextTurnTokenImpact: nextTurnImpact,
          title: output.title ?? null,
          truncated,
          errorText: null,
        });

        // Record 'total' latency phase using the in-memory start time (no DB race)
        if (wallStart !== undefined) {
          writeToolLatencyBreakdown({
            toolCallId: callId,
            sessionId,
            phase: 'total',
            durationMs: wallEnd - wallStart,
            metadataJson: null,
            timestamp: wallEnd,
          });
        }
      });
    },

    // ── SSE event stream: all session info extracted from event payload ────
    event: makeEventHook(),
  };

  return hooks;
};
