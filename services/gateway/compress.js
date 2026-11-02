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

/** Default scope: bulky blocks of at least this many characters (~500 tokens). */
const DEFAULT_MIN_CHARS = 2000;
/** At most this many blocks per request, largest first (each is one compress call). */
const DEFAULT_MAX_BLOCKS = 4;

function messageText(m) {
  return typeof m?.content === "string" ? m.content : null;
}

/**
 * Which messages the gateway may compress. Never the latest user message (the ask) and never
 * system/developer instructions unless the policy opts in (compress_system: true), because
 * rewriting instructions changes model behaviour. Tool results and earlier turns are the
 * bulky context compression is for.
 */
function eligibleBlocks(messages, opts = {}) {
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;
  const maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  const out = [];
  messages.forEach((m, i) => {
    const text = messageText(m);
    if (text == null || text.length < minChars) return;
    if (i === lastUser) return;
    const role = m.role;
    const ok =
      role === "tool" ||
      role === "user" ||
      (role === "assistant" && !m.tool_calls) ||
      (opts.includeSystem && (role === "system" || role === "developer"));
    if (ok) out.push({ index: i, length: text.length });
  });
  return out.sort((a, b) => b.length - a.length).slice(0, maxBlocks);
}

/**
 * @param {{
 *   neuralKeep?: (context: string, query: string) => Promise<object|null>,
 *   localCompress?: (context: string, query: string) => Promise<object>|object,
 *   preferNeural?: boolean,
 *   heuristicFallback?: boolean,
 *   minChars?: number,
 *   maxBlocks?: number,
 * }} [options]
 */
function createCompressFn(options = {}) {
  const preferNeural = options.preferNeural !== false;

  async function compressText(context, ask) {
    if (preferNeural && typeof options.neuralKeep === "function") {
      try {
        const remote = await options.neuralKeep(context, ask);
        if (remote && remote.compressed_text != null) {
          const original = remote.original_tokens || estimateTokens(context);
          const kept = remote.kept_tokens || estimateTokens(remote.compressed_text);
          return {
            compressed_text: remote.compressed_text,
            original_tokens: original,
            kept_tokens: kept,
            engine: "neural_keep",
            strategy: "neural_keep",
          };
        }
      } catch (_) {
        /* fall through to the local compiler */
      }
    }
    if (typeof options.localCompress === "function") {
      try {
        const local = await options.localCompress(context, ask);
        if (local && local.compressed_text != null) {
          return {
            compressed_text: local.compressed_text,
            original_tokens: local.original_tokens || estimateTokens(context),
            kept_tokens:
              local.kept_tokens ?? local.compressed_tokens ?? estimateTokens(local.compressed_text),
            engine: "compiler",
            strategy: local.mode === "neural-keep" ? "neural_keep" : "compiler",
          };
        }
      } catch (_) {
        /* fall through */
      }
    }
    if (options.heuristicFallback) return heuristicCompress(context, ask);
    return null;
  }

  return async function compressCtx(ctx) {
    const ask = ctx.user_ask || "";
    const messages = Array.isArray(ctx.normalized?.messages) ? ctx.normalized.messages : [];
    const blocks = eligibleBlocks(messages, {
      minChars: ctx.compress_opts?.min_chars ?? options.minChars,
      maxBlocks: ctx.compress_opts?.max_blocks ?? options.maxBlocks,
      includeSystem: ctx.compress_opts?.include_system === true,
    });

    if (!blocks.length) {
      ctx.compress_result = { original_tokens: 0, kept_tokens: 0, tokens_saved: 0, strategy: "skip" };
      ctx.compression = traceFromCompressResult({
        original_tokens: 0,
        kept_tokens: 0,
        strategy: "skip",
        skip_reason: "nothing_to_compress",
      });
      return ctx;
    }

    const next = messages.map((m) => ({ ...m }));
    let original = 0;
    let kept = 0;
    const strategies = new Set();
    for (const b of blocks) {
      const text = next[b.index].content;
      const r = await compressText(text, ask);
      const before = estimateTokens(text);
      if (r && r.compressed_text && Number(r.kept_tokens) < Number(r.original_tokens)) {
        next[b.index].content = r.compressed_text;
        original += r.original_tokens;
        kept += Math.min(r.kept_tokens, r.original_tokens);
        strategies.add(r.strategy);
      } else {
        original += before;
        kept += before;
      }
    }
    const strategy = strategies.has("neural_keep")
      ? "neural_keep"
      : strategies.size
        ? "compiler"
        : "skip";

    // Never put the ask into compress_result fields that leak into traces.
    ctx.compress_result = {
      original_tokens: original,
      kept_tokens: kept,
      tokens_saved: Math.max(0, original - kept),
      engine: strategy === "neural_keep" ? "neural_keep" : "compiler",
      strategy,
      blocks: blocks.length,
    };
    ctx.compression = traceFromCompressResult(ctx.compress_result, {
      strategy,
      ...(strategy === "skip" ? { skip_reason: "compressor_unavailable" } : {}),
      dollars_avoided_est: estimateDollarsAvoided(original, kept),
    });
    if (ctx.normalized) ctx.normalized = { ...ctx.normalized, messages: next };
    return ctx;
  };
}

/**
 * Default factory for the gateway: Neural Keep with a short budget (no warm-up wait, one
 * attempt) so a busy worker never stalls the model call, then the local compiler.
 */
function createDefaultCompressFn(options = {}) {
  let neuralKeep = options.neuralKeep;
  if (neuralKeep === undefined) {
    try {
      const nk = require("../../api/_lib/neural-keep");
      const budgetMs = Number(process.env.SC_CP_NK_BUDGET_MS) || 1500;
      neuralKeep = (context, query) =>
        nk.compressViaNeuralKeep(context, query, {
          budgetMs,
          waitReady: false,
          maxAttempts: 1,
          minRemainingMs: 0,
        });
    } catch {
      neuralKeep = null;
    }
  }
  let localCompress = options.localCompress;
  if (localCompress === undefined) {
    try {
      const engine = require("../../api/_lib/engine");
      localCompress = (context, query) => engine.compress(context, query);
    } catch {
      localCompress = null;
    }
  }
  return createCompressFn({
    ...options,
    neuralKeep: neuralKeep || undefined,
    localCompress: localCompress || undefined,
  });
}

module.exports = {
  eligibleBlocks,
  DEFAULT_MIN_CHARS,
  createCompressFn,
  createDefaultCompressFn,
  applyCompressedToMessages,
  heuristicCompress,
  estimateTokens,
};
