#!/usr/bin/env node
/**
 * Shared helpers: compress CONTEXT (never the user ask / query).
 * Headroom-parity session memory:
 *   - only compress *new* chunks (seen hashes skipped)
 *   - append into rolling session memory
 *   - when memory gets big, compact it back down
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
  const parts = raw.split(/\n\s*\n/);
  if (parts.length >= 2 && parts[0].trim().length <= 500) {
    return {
      ask: parts[0].trim(),
      context: parts.slice(1).join("\n\n").trim(),
    };
  }
  const head = raw.slice(0, 400);
  const nl = head.lastIndexOf("\n");
  const cut = nl > 80 ? nl : 400;
  return {
    ask: raw.slice(0, cut).trim() || "Compress the following context for the coding task.",
    context: raw.slice(cut).trim(),
  };
}

function writeInbox(query, compressed, meta, extra = {}) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const latestMd = path.join(INBOX_DIR, "latest.md");
  const latestJson = path.join(INBOX_DIR, "latest.json");
  const body = [
    "# SuperCompress context digest",
    "",
    `Saved: ${new Date().toISOString()}`,
    meta ? `Stats: ${meta}` : "",
    extra.kind ? `Kind: ${extra.kind}` : "",
    extra.session_id ? `Session: ${extra.session_id}` : "",
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
  fs.writeFileSync(latestMd, body);
  fs.writeFileSync(
    latestJson,
    JSON.stringify(
      {
        saved_at: new Date().toISOString(),
        query,
        compressed,
        meta,
        ...extra,
      },
      null,
      2
    )
  );
  return latestMd;
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}

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
  fs.mkdirSync(dir, { recursive: true });
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(memoryPath, state.memory || "");
  const disk = {
    session_id: sessionId,
    seen: state.seen || {},
    seen_order: state.seen_order || [],
    updated_at: state.updated_at,
    compacted_at: state.compacted_at || null,
    memory_chars: (state.memory || "").length,
  };
  fs.writeFileSync(statePath, JSON.stringify(disk, null, 2));
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

  const clipped = ctx.length > 160000 ? ctx.slice(0, 160000) : ctx;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14000);
  try {
    const res = await fetch(COMPRESS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        context: clipped,
        query: q,
        mode: "compiler",
        coding_agent: codingAgent || "Cursor",
        source: opts.source || "cursor-hook",
        session_id: opts.sessionId || null,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { compressed: ctx, skipped: `http_${res.status}` };
    const body = await res.json();
    const compressed =
      body.compressed_text ||
      body.compressed_context ||
      body.compressed ||
      ctx;
    const inTok = body.original_tokens || Math.round(clipped.length / 4);
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
    };
  } catch (err) {
    if (err?.name === "AbortError") return { compressed: ctx, skipped: "timeout" };
    return { compressed: ctx, skipped: "error" };
  } finally {
    clearTimeout(timer);
  }
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
    query || "Compress new context for the coding task. Keep code, paths, errors, decisions.",
    codingAgent,
    { source: kind === "mcp" ? "mcp" : kind || "cursor-hook", sessionId: sid }
  );

  if (
    !deltaResult.compressed ||
    deltaResult.skipped === "empty" ||
    deltaResult.skipped === "too_small" ||
    deltaResult.skipped === "no_key" ||
    String(deltaResult.skipped || "").startsWith("http_")
  ) {
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
    const compactQuery =
      `${query || "coding task"} | Compact this session memory. ` +
      "Keep decisions, file paths, errors, APIs, open TODOs, and key code. Drop chatter and duplicates.";
    const compactResult = await compressContext(state.memory, compactQuery, codingAgent, {
      source: kind === "mcp" ? "mcp" : kind || "cursor-hook",
      sessionId: sid,
    });
    if (compactResult.compressed && !String(compactResult.skipped || "").startsWith("http_")) {
      state.memory = [
        `# Session compact · ${new Date().toISOString().slice(0, 19)}`,
        "",
        compactResult.compressed.trim(),
      ].join("\n");
      state.compacted_at = new Date().toISOString();
      compacted = true;
      compactMeta = compactResult;
      markSeen(state, hashText(state.memory));
    }
  }

  saveSession(sid, state);

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

// Back-compat alias (old name) — still means context compress
async function compressPrompt(context, codingAgent) {
  return compressContext(context, "Compress this context for the coding agent.", codingAgent);
}

module.exports = {
  compressContext,
  compressIncremental,
  compressPrompt,
  writeInbox,
  loadApiKey,
  splitAskAndContext,
  resolveSessionId,
  loadSession,
  saveSession,
  extractNewBlocks,
  hashText,
  INBOX_DIR,
  SESSIONS_DIR,
  COMPACT_CHARS,
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
