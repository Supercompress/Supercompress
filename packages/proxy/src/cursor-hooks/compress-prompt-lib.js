#!/usr/bin/env node
/**
 * Shared helpers: compress CONTEXT (never the user ask / query).
 * Used by Cursor attachment hooks + Claude/Codex pasted-context hooks.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const COMPRESS_URL =
  process.env.SUPERCOMPRESS_COMPRESS_URL ||
  "https://www.supercompress.dev/api/v1/compress";
const BILLING_URL = "https://www.supercompress.dev/dashboard#billing";
const INBOX_DIR = path.join(
  process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(os.homedir(), ".supercompress"),
  "inbox"
);

/** Loud upgrade copy injected into agent context when free quota / credits are exhausted. */
function paywallNotice(detail) {
  const line = String(detail || "").trim();
  return [
    "[SuperCompress PAYWALL] Compression is paused — free 1M tokens used (or credits empty).",
    line || "Add credits to unlock — $0.30 per 1M tokens after free ($10 minimum load).",
    `Upgrade: ${BILLING_URL}`,
  ].join("\n");
}

function loadApiKey() {
  const envKey = String(process.env.SUPERCOMPRESS_API_KEY || "").trim();
  if (envKey && !envKey.includes("${") && envKey.startsWith("sc_")) return envKey;
  try {
    const key = String(
      JSON.parse(
        fs.readFileSync(
          path.join(
            process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(os.homedir(), ".supercompress"),
            "config.json"
          ),
          "utf8"
        )
      ).api_key || ""
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
  // Headroom-parity: only skip splitting when the whole message is tiny
  // (proxy also no-ops under ~100 words of context).
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
  // Single blob: keep a short head as ask, compress the rest
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

/** Compress context against a query. Query is never sent as compressible context. */
async function compressContext(context, query, codingAgent) {
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
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = "";
      let code = "";
      try {
        const errBody = await res.json();
        detail = errBody.detail || errBody.title || "";
        code = errBody.code || "";
      } catch {
        /* ignore non-JSON error bodies */
      }
      const paywalled =
        res.status === 402 ||
        code === "free_quota_exhausted" ||
        code === "credits_exhausted" ||
        /PAYWALL|free_quota|credits_exhausted/i.test(detail);
      if (paywalled) {
        return {
          compressed: "",
          skipped: "paywall",
          paywall: true,
          detail: detail || `HTTP ${res.status}`,
          notice: paywallNotice(detail),
        };
      }
      // Other failures: do not silently re-inject the raw dump as "compressed"
      return { compressed: "", skipped: `http_${res.status}`, detail };
    }
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
    };
  } catch (err) {
    return { compressed: ctx, skipped: err.message || "error" };
  } finally {
    clearTimeout(timer);
  }
}

// Back-compat alias (old name) — still means context compress
async function compressPrompt(context, codingAgent) {
  return compressContext(context, "Compress this context for the coding agent.", codingAgent);
}

/**
 * MCP entrypoint — compress a new context chunk.
 * (Session-memory compaction can layer on later; paywall must surface loudly.)
 */
async function compressIncremental({ context, query, codingAgent } = {}) {
  const result = await compressContext(context, query, codingAgent || "mcp");
  return {
    ...result,
    delta: result.compressed || "",
    compacted: false,
  };
}

module.exports = {
  compressContext,
  compressIncremental,
  compressPrompt,
  writeInbox,
  loadApiKey,
  splitAskAndContext,
  paywallNotice,
  BILLING_URL,
  INBOX_DIR,
};

if (require.main === module) {
  const text = process.argv.slice(2).join(" ") || "";
  const { ask, context } = splitAskAndContext(text);
  compressContext(context || text, ask || "cli", "cli").then((r) => {
    const meta = r.skipped
      ? `skipped=${r.skipped}`
      : `${r.original_tokens}→${r.compressed_tokens} (−${r.savings_pct}%)`;
    const p = writeInbox(ask, r.compressed, meta);
    process.stdout.write(JSON.stringify({ ...r, ask, inbox: p }) + "\n");
  });
}
