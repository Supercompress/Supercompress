#!/usr/bin/env node
/**
 * Shared helpers: compress CONTEXT (never the user ask / query).
 * Headroom-parity session memory:
 *   - only compress *new* chunks (seen hashes skipped)
 *   - append into rolling session memory
 *   - when memory gets big, compact it back down
 * Inbox is session-scoped: inbox/<sessionId>/latest.{md,json}
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const COMPRESS_URL =
  process.env.SUPERCOMPRESS_COMPRESS_URL ||
  "https://www.supercompress.dev/api/v1/compress";
const CONFIG_DIR =
  process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(os.homedir(), ".supercompress");
const INBOX_DIR = path.join(CONFIG_DIR, "inbox");
const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");

/** Soft threshold — compact session memory once it exceeds this many chars. */
const COMPACT_CHARS = Number(process.env.SUPERCOMPRESS_COMPACT_CHARS || 24000);
/** Keep at most this many seen block hashes per session (LRU-ish trim). */
const MAX_SEEN = Number(process.env.SUPERCOMPRESS_MAX_SEEN || 500);
/** Hosted API hard cap — chunk above this rather than 422. */
const API_MAX_CHARS = Number(process.env.SUPERCOMPRESS_API_MAX_CHARS || 120000);
/** Deliberate total cap after chunking (hooks feed full dumps; do not pre-truncate to 180k). */
const HOOK_TOTAL_MAX_CHARS = Number(process.env.SUPERCOMPRESS_HOOK_MAX_CHARS || 1_200_000);

function loadApiKey() {
  const envKey = String(process.env.SUPERCOMPRESS_API_KEY || "").trim();
  if (envKey && !envKey.includes("${") && envKey.startsWith("sc_")) return envKey;
  try {
    const key = String(
      JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf8")).api_key || ""
    ).trim();
    return key.startsWith("sc_") ? key : null;
  } catch {
    return null;
  }
}

/**
 * Split a long user paste into ask (query) + context.
 * Short messages → all ask, empty context.
 * Long messages → first non-empty paragraph / ~400 chars as ask, rest as context.
 */
function splitAskAndContext(text) {
  const raw = String(text || "");
  const minSplit = Number(process.env.SUPERCOMPRESS_HOOK_MIN_CHARS || 400);
  if (raw.trim().length < minSplit) {
    return { ask: raw.trim(), context: "" };
  }
  // Only split on a clear paragraph boundary. Never arbitrarily carve the first
  // ~400 chars of a long instruction — that would compress the user's ask.
  const parts = raw.split(/\n\s*\n/);
  if (parts.length >= 2 && parts[0].trim().length > 0 && parts[0].trim().length <= 800) {
    return {
      ask: parts[0].trim(),
      context: parts.slice(1).join("\n\n").trim(),
    };
  }
  return { ask: raw.trim(), context: "" };
}

function safeSessionSegment(sessionId) {
  const raw = String(sessionId || "").trim();
  if (!raw) return null;
  return raw.replace(/[^\w.-]+/g, "_").slice(0, 80) || null;
}

/** Session-scoped inbox directory (required for writes that carry a session id). */
function inboxDirForSession(sessionId) {
  const safe = safeSessionSegment(sessionId);
  if (!safe) return INBOX_DIR;
  return path.join(INBOX_DIR, safe);
}

function inboxPaths(sessionId) {
  const dir = inboxDirForSession(sessionId);
  return {
    dir,
    latestMd: path.join(dir, "latest.md"),
    latestJson: path.join(dir, "latest.json"),
  };
}

function writeInbox(query, compressed, meta, extra = {}) {
  const sessionId = extra.session_id || extra.sessionId || null;
  const { dir, latestMd, latestJson } = inboxPaths(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = [
    "# SuperCompress context digest",
    "",
    `Saved: ${new Date().toISOString()}`,
    meta ? `Stats: ${meta}` : "",
    extra.kind ? `Kind: ${extra.kind}` : "",
    sessionId ? `Session: ${sessionId}` : "",
    "",
    "## User ask (never compressed)",
    "",
    query || "(none)",
    "",
    "## Compressed context",
    "",
    compressed || "(empty)",
    "",
  ].join("\n");
  fs.writeFileSync(latestMd, body, { mode: 0o600 });
  fs.writeFileSync(
    latestJson,
    JSON.stringify(
      {
        saved_at: new Date().toISOString(),
        query,
        compressed,
        meta,
        ...extra,
        session_id: sessionId || extra.session_id || null,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  return latestMd;
}

function readInboxDigest(sessionId) {
  const safe = safeSessionSegment(sessionId);
  if (!safe) return "";
  try {
    const p = path.join(INBOX_DIR, safe, "latest.md");
    if (!fs.existsSync(p)) return "";
    const body = fs.readFileSync(p, "utf8").trim();
    return body.length > 40 ? body : "";
  } catch {
    return "";
  }
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}

function fullHash(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

/** Stable Idempotency-Key so hook timeouts can safely retry without double-billing.
 * Must stay ≤40 chars — Auth claims watermarks truncate to 40; longer keys 503'd billing.
 */
function stableIdempotencyKey({ sessionId, context, mode, query }) {
  return crypto
    .createHash("sha256")
    .update(String(sessionId || ""))
    .update("\0")
    .update(fullHash(context))
    .update("\0")
    .update(String(mode || "compiler"))
    .update("\0")
    .update(fullHash(String(query || "").trim().toLowerCase()))
    .digest("hex")
    .slice(0, 40);
}

/**
 * Resolve a session bucket for inbox / memory.
 * @param {{ fallback?: "cwd"|"ephemeral"|"none" }} [input]
 */
function resolveSessionId(input = {}) {
  const raw =
    input.session_id ||
    input.sessionId ||
    input.conversation_id ||
    input.conversationId ||
    input.composerId ||
    process.env.SUPERCOMPRESS_SESSION_ID ||
    "";
  if (raw) return String(raw).replace(/[^\w.-]+/g, "_").slice(0, 80);
  const fallback = String(input.fallback || "cwd").toLowerCase();
  if (fallback === "none") return null;
  if (fallback === "ephemeral") {
    return `ephemeral_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }
  const cwd = String(input.cwd || process.env.CURSOR_PROJECT_DIR || process.cwd() || "default");
  return `cwd_${hashText(cwd)}`;
}

function sessionPaths(sessionId) {
  const dir = path.join(SESSIONS_DIR, sessionId || "default");
  return {
    dir,
    statePath: path.join(dir, "state.json"),
    memoryPath: path.join(dir, "memory.md"),
  };
}

function loadSession(sessionId) {
  const { statePath, memoryPath } = sessionPaths(sessionId);
  let state = {
    session_id: sessionId,
    seen: {},
    seen_order: [],
    memory: "",
    updated_at: null,
    compacted_at: null,
  };
  try {
    if (fs.existsSync(statePath)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(statePath, "utf8")) };
    }
  } catch {}
  try {
    if (fs.existsSync(memoryPath)) {
      state.memory = fs.readFileSync(memoryPath, "utf8");
    }
  } catch {}
  if (!state.seen || typeof state.seen !== "object") state.seen = {};
  if (!Array.isArray(state.seen_order)) state.seen_order = Object.keys(state.seen);
  return state;
}

function saveSession(sessionId, state) {
  const { dir, statePath, memoryPath } = sessionPaths(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  state.updated_at = new Date().toISOString();
  const disk = {
    session_id: sessionId,
    seen: state.seen || {},
    seen_order: state.seen_order || [],
    updated_at: state.updated_at,
    compacted_at: state.compacted_at || null,
    memory_chars: (state.memory || "").length,
  };
  // Atomic-ish write: temp + rename reduces cross-hook lost updates.
  const memTmp = `${memoryPath}.${process.pid}.tmp`;
  const stateTmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(memTmp, state.memory || "", { mode: 0o600 });
  fs.writeFileSync(stateTmp, JSON.stringify(disk, null, 2), { mode: 0o600 });
  fs.renameSync(memTmp, memoryPath);
  fs.renameSync(stateTmp, statePath);
}

function markSeen(state, hash) {
  if (!hash) return;
  if (!state.seen[hash]) {
    state.seen[hash] = true;
    state.seen_order.push(hash);
  }
  while (state.seen_order.length > MAX_SEEN) {
    const old = state.seen_order.shift();
    delete state.seen[old];
  }
}

/**
 * Split context into stable blocks. Only return blocks not already in `seen`.
 */
function extractNewBlocks(context, seen = {}) {
  const text = String(context || "").trim();
  if (!text) return [];

  // Prefer paragraph splits; fall back to sized windows for dense blobs
  let parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1 && text.length > 4000) {
    parts = [];
    const win = 3000;
    for (let i = 0; i < text.length; i += win) {
      parts.push(text.slice(i, i + win).trim());
    }
  }

  // Merge tiny fragments so hashing stays meaningful
  const blocks = [];
  let buf = "";
  for (const p of parts) {
    if ((buf + "\n\n" + p).trim().length < 240) {
      buf = buf ? `${buf}\n\n${p}` : p;
      continue;
    }
    if (buf) blocks.push(buf);
    buf = p;
  }
  if (buf) blocks.push(buf);

  return blocks.filter((b) => b.length >= 40 && !seen[hashText(b)]);
}

function chunkText(text, maxChars = API_MAX_CHARS) {
  const raw = String(text || "");
  if (raw.length <= maxChars) return [raw];
  const chunks = [];
  let i = 0;
  while (i < raw.length) {
    let end = Math.min(i + maxChars, raw.length);
    if (end < raw.length) {
      const code = raw.charCodeAt(end - 1);
      // If the boundary lands on a high surrogate (0xD800–0xDBFF), step back 1
      // code unit so the full surrogate pair remains together in the next chunk.
      if (code >= 0xd800 && code <= 0xdbff) {
        if (end - 1 > i) {
          end--;
        }
      }
    }
    chunks.push(raw.slice(i, end));
    i = end;
  }
  return chunks;
}

async function compressOnce(context, query, codingAgent, opts = {}) {
  const apiKey = loadApiKey();
  if (!apiKey) return { compressed: context, skipped: "no_key" };

  const idempotencyKey = stableIdempotencyKey({
    sessionId: opts.sessionId,
    context,
    mode: "compiler",
    query,
  });
  const maxAttempts = Number(opts.maxAttempts || 3);
  let lastSkip = "error";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14000);
    try {
      const res = await fetch(COMPRESS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          context,
          query,
          mode: "compiler",
          coding_agent: codingAgent || "Cursor",
          source: opts.source || "cursor-hook",
          session_id: opts.sessionId || null,
          request_id: idempotencyKey,
          idempotency_key: idempotencyKey,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        lastSkip = `http_${res.status}`;
        // Retry transient platform pressure; idempotency key makes this billing-safe.
        if ((res.status === 503 || res.status === 429 || res.status >= 520) && attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        return { compressed: context, skipped: lastSkip };
      }
      const body = await res.json();
      const compressed =
        body.compressed_text ||
        body.compressed_context ||
        body.compressed ||
        context;
      const inTok = body.original_tokens || Math.round(context.length / 4);
      const outTok = body.kept_tokens || body.compressed_tokens || Math.round(compressed.length / 4);
      const pct =
        body.tokens_saved_pct != null
          ? Math.round(body.tokens_saved_pct)
          : body.kv_savings_pct != null
            ? Math.round(body.kv_savings_pct)
            : inTok > 0
              ? Math.round(((inTok - outTok) / inTok) * 100)
              : 0;
      return {
        compressed,
        original_tokens: inTok,
        compressed_tokens: outTok,
        savings_pct: pct,
        latency_ms: body.latency_ms || null,
        request_id: idempotencyKey,
      };
    } catch (err) {
      if (err?.name === "AbortError") {
        lastSkip = "timeout";
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        return { compressed: context, skipped: "timeout" };
      }
      lastSkip = "error";
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return { compressed: context, skipped: "error" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { compressed: context, skipped: lastSkip };
}

/** Compress context against a query. Query is never sent as compressible context. */
async function compressContext(context, query, codingAgent, opts = {}) {
  const ctx = String(context || "").trim();
  const q = String(query || "").trim() || "Compress this context for the coding task.";
  if (!ctx) return { compressed: "", skipped: "empty" };
  if (ctx.length < 40) {
    return { compressed: ctx, skipped: "too_small", original_tokens: Math.ceil(ctx.length / 4) };
  }
  const apiKey = loadApiKey();
  if (!apiKey) return { compressed: ctx, skipped: "no_key" };

  const bounded =
    ctx.length > HOOK_TOTAL_MAX_CHARS ? ctx.slice(0, HOOK_TOTAL_MAX_CHARS) : ctx;
  const chunks = chunkText(bounded, API_MAX_CHARS);
  if (chunks.length === 1) {
    return compressOnce(chunks[0], q, codingAgent, opts);
  }

  const parts = [];
  let totalIn = 0;
  let totalOut = 0;
  let lastSkip = null;
  let okChunks = 0;
  let failedChunks = 0;
  for (let i = 0; i < chunks.length; i++) {
    const partQuery = `${q} (part ${i + 1}/${chunks.length})`;
    const r = await compressOnce(chunks[i], partQuery, codingAgent, {
      ...opts,
      // Distinct keys per chunk so retries stay bound to that slice.
      sessionId: `${opts.sessionId || "default"}:chunk${i}`,
    });
    if (
      !r.compressed ||
      r.skipped === "no_key" ||
      r.skipped === "timeout" ||
      r.skipped === "error" ||
      String(r.skipped || "").startsWith("http_")
    ) {
      lastSkip = r.skipped || "error";
      failedChunks += 1;
      // Never reinject raw failed chunks into the digest — callers must skip publish
      // on partial_chunk_failure so 120k dumps do not leak back into agent context.
      totalIn += Math.round(chunks[i].length / 4);
      continue;
    }
    okChunks += 1;
    parts.push(r.compressed);
    totalIn += r.original_tokens || Math.round(chunks[i].length / 4);
    totalOut += r.compressed_tokens || Math.round(r.compressed.length / 4);
  }
  const compressed = parts.join("\n\n");
  const pct = totalIn > 0 ? Math.round(((totalIn - totalOut) / totalIn) * 100) : 0;
  const partial = okChunks > 0 && failedChunks > 0;
  const allFailed = okChunks === 0 && failedChunks > 0;
  return {
    compressed,
    original_tokens: totalIn,
    compressed_tokens: totalOut,
    savings_pct: pct,
    // Only treat as total skip when every chunk failed — partial stays retryable upstream.
    skipped: allFailed ? lastSkip || "error" : partial ? "partial_chunk_failure" : null,
    partial,
    chunked: true,
    chunks: chunks.length,
    chunks_ok: okChunks,
    chunks_failed: failedChunks,
  };
}

/**
 * Headroom-style path:
 * 1) compress only unseen (new) blocks
 * 2) append into session memory
 * 3) if memory is large, compact the whole memory
 *
 * Returns a digest suitable for inbox / additional_context (full memory, not just delta).
 */
async function compressIncremental({ context, query, codingAgent, sessionId, kind }) {
  const sid = sessionId || "default";
  const state = loadSession(sid);
  const newBlocks = extractNewBlocks(context, state.seen);

  if (!newBlocks.length) {
    // Nothing new — still surface existing memory if present
    if (state.memory && state.memory.trim()) {
      return {
        compressed: state.memory,
        skipped: "already_seen",
        original_tokens: 0,
        compressed_tokens: Math.round(state.memory.length / 4),
        savings_pct: 0,
        session_id: sid,
        compacted: false,
        delta: "",
      };
    }
    return { compressed: "", skipped: "already_seen", session_id: sid };
  }

  const newText = newBlocks.join("\n\n");
  const deltaResult = await compressContext(
    newText,
    query ||
      "Coding-agent context dump. Keep stack traces, errors, file contents, return values, and task symbols.",
    codingAgent,
    { source: kind === "mcp" ? "mcp" : kind || "cursor-hook", sessionId: sid }
  );

  if (
    !deltaResult.compressed ||
    deltaResult.partial ||
    deltaResult.skipped === "empty" ||
    deltaResult.skipped === "too_small" ||
    deltaResult.skipped === "no_key" ||
    deltaResult.skipped === "timeout" ||
    deltaResult.skipped === "error" ||
    deltaResult.skipped === "partial_chunk_failure" ||
    String(deltaResult.skipped || "").startsWith("http_")
  ) {
    // Do not markSeen on timeout/error/partial — failed slices must remain retryable.
    return { ...deltaResult, session_id: sid, compacted: false, delta: "" };
  }

  for (const b of newBlocks) markSeen(state, hashText(b));
  // Also mark whole-blob hash so identical re-pastes skip
  markSeen(state, hashText(String(context || "").trim()));

  const stamp = new Date().toISOString().slice(0, 19);
  const deltaSection = [
    `### + ${kind || "new"} · ${stamp}`,
    "",
    deltaResult.compressed.trim(),
  ].join("\n");

  state.memory = state.memory && state.memory.trim()
    ? `${state.memory.trim()}\n\n${deltaSection}`
    : `# Session memory\n\n${deltaSection}`;

  let compacted = false;
  let compactMeta = null;
  if (state.memory.length >= COMPACT_CHARS) {
    const compactResult = await compactSessionMemory(sid, query, {
      codingAgent,
      kind,
      persistInbox: false,
      state,
    });
    if (compactResult.compacted) {
      compacted = true;
      compactMeta = compactResult;
    } else {
      // Compact failed — still persist the appended delta memory.
      saveSession(sid, state);
    }
  } else {
    saveSession(sid, state);
  }

  const inTok = deltaResult.original_tokens || 0;
  const outTok = Math.round(state.memory.length / 4);
  const pct = inTok > 0 ? Math.round(((inTok - (deltaResult.compressed_tokens || 0)) / inTok) * 100) : 0;

  return {
    compressed: state.memory,
    delta: deltaResult.compressed,
    original_tokens: inTok,
    compressed_tokens: outTok,
    savings_pct: pct,
    session_id: sid,
    compacted,
    compact: compactMeta,
    skipped: null,
  };
}

/**
 * Compact existing session memory (used by OpenClaw compact:before).
 * Unlike compressIncremental(""), this always runs COMPACT against memory.
 */
async function compactSessionMemory(sessionId, query, opts = {}) {
  const sid = sessionId || "default";
  const state = opts.state || loadSession(sid);
  const memory = String(state.memory || "").trim();
  if (memory.length < 80) {
    return {
      compressed: memory,
      skipped: "too_small",
      session_id: sid,
      compacted: false,
    };
  }

  const codingAgent = opts.codingAgent || "OpenClaw";
  const compactQuery =
    `${query || "coding task"} | Compact this session memory. ` +
    "Keep decisions, file paths, errors, APIs, open TODOs, and key code. Drop chatter and duplicates.";
  const compactResult = await compressContext(memory, compactQuery, codingAgent, {
    source: opts.kind === "mcp" ? "mcp" : opts.kind || "openclaw:compact",
    sessionId: sid,
  });

  if (
    !compactResult.compressed ||
    compactResult.skipped === "no_key" ||
    compactResult.skipped === "timeout" ||
    compactResult.skipped === "error" ||
    String(compactResult.skipped || "").startsWith("http_")
  ) {
    return { ...compactResult, session_id: sid, compacted: false };
  }

  state.memory = [
    `# Session compact · ${new Date().toISOString().slice(0, 19)}`,
    "",
    compactResult.compressed.trim(),
  ].join("\n");
  state.compacted_at = new Date().toISOString();
  markSeen(state, hashText(state.memory));
  saveSession(sid, state);

  const meta = `${compactResult.original_tokens || "?"}→${
    compactResult.compressed_tokens || Math.round(state.memory.length / 4)
  } (−${compactResult.savings_pct || 0}%)`;
  if (opts.persistInbox !== false) {
    writeInbox(query || "compact session memory", state.memory, meta, {
      kind: opts.kind || "openclaw-compact",
      session_id: sid,
      compacted: true,
    });
  }

  return {
    ...compactResult,
    compressed: state.memory,
    session_id: sid,
    compacted: true,
  };
}

// Back-compat alias (old name) — still means context compress
async function compressPrompt(context, codingAgent) {
  return compressContext(context, "Compress this context for the coding agent.", codingAgent);
}

/**
 * Whether a compress result is safe to write into inbox / additional_context.
 * Partial chunk failures must never reinject mixed raw+compressed dumps.
 */
function shouldPublishCompressedResult(result) {
  if (!result || !result.compressed) return false;
  if (result.partial || result.skipped === "partial_chunk_failure") return false;
  if (result.skipped === "no_key" || result.skipped === "timeout" || result.skipped === "error") {
    return false;
  }
  if (String(result.skipped || "").startsWith("http_")) return false;
  if (result.paywall || result.skipped === "paywall") return false;
  return true;
}

module.exports = {
  compressContext,
  compressIncremental,
  compactSessionMemory,
  compressPrompt,
  shouldPublishCompressedResult,
  writeInbox,
  readInboxDigest,
  inboxPaths,
  loadApiKey,
  splitAskAndContext,
  resolveSessionId,
  loadSession,
  saveSession,
  extractNewBlocks,
  hashText,
  stableIdempotencyKey,
  chunkText,
  CONFIG_DIR,
  INBOX_DIR,
  SESSIONS_DIR,
  COMPACT_CHARS,
  API_MAX_CHARS,
};

if (require.main === module) {
  const text = process.argv.slice(2).join(" ") || "";
  const { ask, context } = splitAskAndContext(text);
  compressIncremental({
    context: context || text,
    query: ask || "cli",
    codingAgent: "cli",
    sessionId: "cli",
    kind: "cli",
  }).then((r) => {
    const meta = r.skipped
      ? `skipped=${r.skipped}`
      : `${r.original_tokens}→${r.compressed_tokens} (−${r.savings_pct}%)${r.compacted ? " · compacted" : ""}`;
    const p = writeInbox(ask, r.compressed, meta, { kind: "cli", session_id: r.session_id });
    process.stdout.write(JSON.stringify({ ...r, ask, inbox: p }) + "\n");
  });
}
