"use strict";

/**
 * In-path compress for the gateway.
 * - Never compresses the user ask (query is passed to NK for relevance only).
 * - Emits Compression Trace sizes used by post-compress routing.
 * - Tries Neural Keep when configured; else optional localCompress; else heuristic stub.
 */

const {
  traceFromCompressResult,
  estimateDollarsAvoided,
} = require("../../packages/control-plane");

function estimateTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  // ~4 chars/token heuristic — matches wire.js stub
  return Math.max(1, Math.ceil(s.length / 4));
}

function applyCompressedToMessages(normalized, compressedContext, ask) {
  const msgs = Array.isArray(normalized?.messages) ? [...normalized.messages] : [];
  const next = [];
  let wroteSystem = false;
  for (const m of msgs) {
    if (m.role === "system") {
      if (!wroteSystem) {
        next.push({ role: "system", content: compressedContext });
        wroteSystem = true;
      }
      // drop extra system blobs — already folded into context
      continue;
    }
    if (m.role === "user") {
      // Preserve ask text exactly (last user message kept as-is)
      next.push({ ...m });
      continue;
    }
    next.push({ ...m });
  }
  if (!wroteSystem && compressedContext) {
    next.unshift({ role: "system", content: compressedContext });
  }
  // Ensure ask still present
  if (ask && !next.some((m) => m.role === "user" && m.content === ask)) {
    const lastUser = [...next].reverse().find((m) => m.role === "user");
    if (!lastUser) next.push({ role: "user", content: ask });
  }
  return { ...normalized, messages: next };
}

function heuristicCompress(context, _ask) {
  const original = estimateTokens(context);
  const keptRatio = 0.4;
  const compressed = String(context).slice(0, Math.ceil(String(context).length * keptRatio));
  const kept = Math.max(1, Math.ceil(original * keptRatio));
  // Local heuristic is labeled "compiler" (deterministic keep) — never "unknown" in live path.
  return {
    compressed_text: compressed,
    original_tokens: original,
    kept_tokens: kept,
    tokens_saved: Math.max(0, original - kept),
    engine: "compiler",
    strategy: "compiler",
  };
}

/**
 * @param {{
 *   neuralKeep?: (context: string, query: string) => Promise<object|null>,
 *   localCompress?: (context: string, query: string) => Promise<object>,
 *   preferNeural?: boolean,
 * }} [options]
 */
function createCompressFn(options = {}) {
  const preferNeural = options.preferNeural !== false;

  return async function compressCtx(ctx) {
    const ask = ctx.user_ask || "";
    const context = ctx.context || "";

    let result = null;
    let strategy = "unknown";

    if (preferNeural && typeof options.neuralKeep === "function" && context) {
      try {
        const remote = await options.neuralKeep(context, ask);
        if (remote && remote.compressed_text != null) {
          result = {
            compressed_text: remote.compressed_text,
            original_tokens: remote.original_tokens || estimateTokens(context),
            kept_tokens: remote.kept_tokens || estimateTokens(remote.compressed_text),
            tokens_saved: 0,
            engine: "neural_keep",
            strategy: "neural_keep",
            neural_keep: true,
            mode: remote.mode || "neural-keep",
          };
          result.tokens_saved = Math.max(
            0,
            result.original_tokens - result.kept_tokens
          );
          strategy = "neural_keep";
        }
      } catch (_) {
        // fall through — never fail the gateway solely on NK
      }
    }

    if (!result && typeof options.localCompress === "function" && context) {
      try {
        const local = await options.localCompress(context, ask);
        if (local && local.compressed_text != null) {
          result = {
            compressed_text: local.compressed_text,
            original_tokens: local.original_tokens || estimateTokens(context),
            kept_tokens:
              local.kept_tokens ?? local.compressed_tokens ?? estimateTokens(local.compressed_text),
            tokens_saved: local.tokens_saved,
            engine: local.mode === "compiler" || local.engine === "compiler" ? "compiler" : local.engine || "compiler",
            strategy: local.mode === "neural-keep" ? "neural_keep" : "compiler",
          };
          strategy = result.strategy;
        }
      } catch (_) {
        /* fall through */
      }
    }

    if (!result) {
      result = heuristicCompress(context, ask);
      strategy = "compiler";
    }

    // Never put ask into compress_result fields that leak into traces
    ctx.compress_result = {
      original_tokens: result.original_tokens,
      kept_tokens: result.kept_tokens,
      tokens_saved: result.tokens_saved ?? Math.max(0, result.original_tokens - result.kept_tokens),
      compressed: result.compressed_text,
      engine: result.engine,
      strategy,
    };

    ctx.compression = traceFromCompressResult(ctx.compress_result, {
      strategy,
      dollars_avoided_est: estimateDollarsAvoided(
        ctx.compress_result.original_tokens,
        ctx.compress_result.kept_tokens
      ),
    });

    // Apply compressed context to normalized messages; ask untouched
    if (ctx.normalized) {
      ctx.normalized = applyCompressedToMessages(
        ctx.normalized,
        result.compressed_text,
        ask
      );
    }
    ctx.context = result.compressed_text;
    return ctx;
  };
}

/**
 * Default factory: lazy-require Neural Keep client when available.
 */
function createDefaultCompressFn(options = {}) {
  let neuralKeep = options.neuralKeep;
  if (neuralKeep === undefined) {
    try {
      const nk = require("../../api/_lib/neural-keep");
      neuralKeep = (context, query) => nk.compressViaNeuralKeep(context, query);
    } catch {
      neuralKeep = null;
    }
  }
  return createCompressFn({
    ...options,
    neuralKeep: neuralKeep || undefined,
    localCompress: options.localCompress,
  });
}

module.exports = {
  createCompressFn,
  createDefaultCompressFn,
  applyCompressedToMessages,
  heuristicCompress,
  estimateTokens,
};
