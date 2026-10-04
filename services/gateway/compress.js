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

function heuristicCompress(context, ask) {
  const text = String(context || "");
  const original = estimateTokens(text);
  if (!text) {
    return {
      compressed_text: "",
      original_tokens: 0,
      kept_tokens: 0,
      tokens_saved: 0,
      engine: "compiler",
      strategy: "compiler",
    };
  }

  // Line-aware keep: head + ask-overlapping lines + tail. Beats naive 40% slice.
  // If the blob has no newlines, chunk by words so we can still shrink.
  let lines = text.split(/\r?\n/);
  if (lines.length <= 1 && text.length > 120) {
    const words = text.split(/\s+/);
    const chunk = [];
    let buf = [];
    for (const w of words) {
      buf.push(w);
      if (buf.join(" ").length >= 48) {
        chunk.push(buf.join(" "));
        buf = [];
      }
    }
    if (buf.length) chunk.push(buf.join(" "));
    lines = chunk.length ? chunk : lines;
  }
  const askTerms = String(ask || "")
    .toLowerCase()
    .split(/[^a-z0-9_\-]{2,}/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4)
    .slice(0, 12);

  const scored = lines.map((line, idx) => {
    const lower = line.toLowerCase();
    let score = 0;
    if (idx < 3) score += 3;
    if (idx >= lines.length - 3) score += 2;
    for (const t of askTerms) {
      if (t && lower.includes(t)) score += 4;
    }
    if (/error|exception|fail|root.?cause|fix|todo|must|required/i.test(line)) score += 2;
    if (line.trim().length === 0) score -= 1;
    return { line, idx, score };
  });

  const targetChars = Math.max(
    80,
    Math.ceil(text.length * 0.35)
  );
  const picked = new Set();
  // Always keep head/tail anchors
  for (let i = 0; i < Math.min(2, lines.length); i++) picked.add(i);
  for (let i = Math.max(0, lines.length - 2); i < lines.length; i++) picked.add(i);

  const byScore = [...scored].sort((a, b) => b.score - a.score || a.idx - b.idx);
  let chars = [...picked].reduce((s, i) => s + (lines[i]?.length || 0) + 1, 0);
  for (const row of byScore) {
    if (picked.has(row.idx)) continue;
    if (chars >= targetChars && picked.size >= 4) break;
    if (row.score <= 0 && chars >= targetChars * 0.7) continue;
    picked.add(row.idx);
    chars += row.line.length + 1;
  }

  const ordered = [...picked].sort((a, b) => a - b);
  const compressed = ordered.map((i) => lines[i]).join("\n");
  const kept = Math.max(1, estimateTokens(compressed));
  return {
    compressed_text: compressed,
    original_tokens: original,
    kept_tokens: Math.min(kept, original),
    tokens_saved: Math.max(0, original - Math.min(kept, original)),
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
