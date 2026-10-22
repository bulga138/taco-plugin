import type { Plugin } from '@opencode/plugin';
import { captureSystemPrompt } from './hooks/system-prompt.js';
import { makeEventHandler } from './hooks/events.js';
import { closePluginDb, PLUGIN_DB_PATH, getPluginDb } from './db/connection.js';
import { writeChatParams, writeTokenEstimate } from './db/writers.js';
import { writeContextSnapshot } from './db/writers.js';
import { writeToolCallStart } from './db/writers.js';
import { writeToolCallEnd } from './db/writers.js';
import { writeToolLatencyBreakdown } from './db/writers.js';
import { estimateTokens } from './tokenizer/index.js';
import { maybeCompress } from './utils/compress.js';

// ─── Model info cache (limit + cost for chat_params columns) ─────────────────

interface ModelInfoLite {
  limit?: { context?: number; output?: number } | null;
  cost?:
    | ReadonlyArray<{
        input?: number;
        output?: number;
        cache?: { read?: number; write?: number };
      }>
    | null;
}

const EMPTY_MODELS = new Map<string, ModelInfoLite>();

async function loadModels(ctx: Plugin.Context): Promise<Map<string, ModelInfoLite>> {
  try {
    const res = await ctx.model.list();
    const map = new Map<string, ModelInfoLite>();
    for (const info of res.data ?? []) {
      const key = `${info.providerID}/${info.modelID ?? info.id}`;
      map.set(key, info as ModelInfoLite);
    }
    return map;
  } catch (err) {
    console.error('[taco-plugin] model.list error:', (err as Error).message);
    return EMPTY_MODELS;
  }
}

export async function setup(ctx: Plugin.Context) {
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

  // In-memory model cache: sessionId → modelId (populated by context hook, cleared on session end)
  const _modelCache = new Map<string, string>();

  // In-memory start-time cache: callId → wallStart ms (populated by before, consumed by after)
  const _toolStartTimes = new Map<string, number>();

  // Model info (limits + cost rates) — loaded once, then cached
  const _modelsPromise = loadModels(ctx);

  function resolveModelId(sessionId: string): string {
    let modelId = _modelCache.get(sessionId) ?? '';
    if (!modelId) {
      try {
        const db = getPluginDb();
        const row = db
          .query<{ model_id: string }, [string]>(
            `SELECT model_id FROM chat_params WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`,
          )
          .get(sessionId);
        modelId = row?.model_id ?? '';
        if (modelId) _modelCache.set(sessionId, modelId);
      } catch {
        /* ok — modelId stays '' */
      }
    }
    return modelId;
  }

  // ── context hook: chat params + system prompt + context snapshot ─────────
  await ctx.session.hook('context', async event => {
    try {
      const sessionId = String(event.sessionID);
      const modelId = String(event.model.id);
      const providerId = String(event.model.providerID);
      const now = Date.now();
      // Synthetic id — the V2 context hook carries no messageID
      const messageId = `${sessionId}:${now}`;

      const models = await _modelsPromise;
      const info = models.get(`${providerId}/${modelId}`);
      const cost0 = info?.cost?.[0];

      // Cache modelId so tool hooks and event handling don't need a DB round-trip
      _modelCache.set(sessionId, modelId);

      const options = event.options as Record<string, unknown> | undefined;
      const optionsJson =
        options && Object.keys(options).length > 0 ? JSON.stringify(options) : null;

      queueMicrotask(() => {
        try {
          writeChatParams({
            id: messageId,
            sessionId,
            timestamp: now,
            modelId,
            providerId,
            agent: String(event.agent ?? ''),
            temperature: (options?.temperature as number | undefined) ?? null,
            topP: (options?.topP as number | undefined) ?? null,
            topK: (options?.topK as number | undefined) ?? null,
            maxOutputTokens: (options?.maxOutputTokens as number | undefined) ?? null,
            modelContextLimit: info?.limit?.context ?? null,
            modelOutputLimit: info?.limit?.output ?? null,
            costInput: cost0?.input ?? null,
            costOutput: cost0?.output ?? null,
            costCacheRead: cost0?.cache?.read ?? null,
            costCacheWrite: cost0?.cache?.write ?? null,
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
          console.error('[taco-plugin] context hook microtask error:', (err as Error).message);
        }
      });

      // System prompt
      captureSystemPrompt(sessionId, modelId, event.system);

      // Context window snapshot — V2 messages carry `content` parts
      let toolTokens = 0;
      let convTokens = 0;
      let totalParts = 0;
      let toolParts = 0;
      let textParts = 0;

      for (const msg of event.messages) {
        const parts = (msg as Record<string, unknown>).content as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          totalParts++;
          const type = part.type as string | undefined;

          if (type === 'tool-result') {
            toolParts++;
            const result = part.result as { value?: unknown } | undefined;
            const s = JSON.stringify(result?.value ?? '');
            if (s && s !== 'null' && s !== '""') toolTokens += estimateTokens(s, modelId).count;
          } else if (type === 'text') {
            textParts++;
            const text = part.text as string | undefined;
            if (text) convTokens += estimateTokens(text, modelId).count;
          }
        }
      }

      const estimatedTokens = toolTokens + convTokens;
      const contextLimit = info?.limit?.context ?? null;
      const contextUtilization =
        contextLimit && contextLimit > 0 ? estimatedTokens / contextLimit : null;
      const total = estimatedTokens || 1;

      queueMicrotask(() => {
        writeContextSnapshot({
          id: messageId,
          sessionId,
          timestamp: Date.now(),
          messageCount: event.messages.length,
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
    } catch (err) {
      console.error('[taco-plugin] context hook error:', (err as Error).message);
    }
  });

  // ── tool.execute.before: sessionID from event, modelId via cache ─────────
  await ctx.tool.hook('execute.before', async event => {
    try {
      const callId = String(event.id);
      const sessionId = String(event.sessionID);
      const tool = event.tool;
      // Capture wall-clock start for latency breakdown (used in after hook)
      const wallStart = Date.now();
      _toolStartTimes.set(callId, wallStart);

      const modelId = resolveModelId(sessionId);
      const inputJson = JSON.stringify(event.input ?? null);
      const inputBytes = Buffer.byteLength(inputJson, 'utf8');
      const inputToks = estimateTokens(inputJson, modelId).count;

      queueMicrotask(() => {
        writeToolCallStart({
          id: callId,
          sessionId,
          messageId: String(event.messageID ?? ''),
          tool,
          timestampStart: wallStart,
          inputJson,
          inputSizeBytes: inputBytes,
          inputEstimatedTokens: inputToks,
        });
      });
    } catch (err) {
      console.error('[taco-plugin] tool.execute.before error:', (err as Error).message);
    }
  });

  // ── tool.execute.after: sessionID from event, modelId via cache ──────────
  await ctx.tool.hook('execute.after', async event => {
    try {
      const callId = String(event.id);
      const sessionId = String(event.sessionID);
      const wallEnd = Date.now();

      // Consume start time from memory (set by tool.execute.before)
      const wallStart = _toolStartTimes.get(callId);
      _toolStartTimes.delete(callId);

      const modelId = resolveModelId(sessionId);

      let rawOutput = '';
      let truncated = false;
      let title: string | null = null;
      let status: 'completed' | 'error' = 'completed';
      let errorText: string | null = null;

      if (event.status === 'completed') {
        const result = event.result;
        if (typeof result.content === 'string') {
          rawOutput = result.content;
        } else if (Array.isArray(result.content)) {
          rawOutput = result.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map(c => c.text)
            .join('\n');
        } else if (result.output != null) {
          rawOutput =
            typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
        }
        const meta = result.metadata as Record<string, unknown> | undefined;
        truncated = meta?.truncated === true;
        title = typeof meta?.title === 'string' ? meta.title : null;
      } else {
        status = 'error';
        errorText = event.error?.message ?? String(event.error ?? 'unknown error');
        rawOutput = errorText;
      }

      const { data, compressed, sizeBytes } = maybeCompress(rawOutput);
      const outputToks = estimateTokens(rawOutput, modelId).count;
      // next_turn_token_impact: how many tokens this result will consume as input next turn
      const nextTurnImpact = outputToks;

      queueMicrotask(() => {
        writeToolCallEnd({
          id: callId,
          timestampEnd: wallEnd,
          status,
          outputText: data,
          outputCompressed: compressed,
          outputSizeBytes: sizeBytes,
          outputEstimatedTokens: outputToks,
          nextTurnTokenImpact: nextTurnImpact,
          title,
          truncated,
          errorText,
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
    } catch (err) {
      console.error('[taco-plugin] tool.execute.after error:', (err as Error).message);
    }
  });

  // ── SSE event stream ─────────────────────────────────────────────────────
  const controller = new AbortController();
  const handleEvent = makeEventHandler(_modelCache);
  void (async () => {
    try {
      for await (const evt of ctx.event.subscribe({ signal: controller.signal })) {
        handleEvent(evt as { id?: string; type: string; data: Record<string, unknown> });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error('[taco-plugin] event stream error:', (err as Error).message);
      }
    }
  })();

  // Cleanup on plugin teardown
  return () => {
    controller.abort();
  };
}
