#!/usr/bin/env node
/**
 * Cursor postToolUse — auto-compress large tool outputs via SuperCompress API.
 * Injects a compressed digest as additional_context so the model does not
 * re-spend tokens on the raw dump. Fail-open on any error.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const COMPRESS_URL =
  process.env.SUPERCOMPRESS_COMPRESS_URL ||
  "https://www.supercompress.dev/api/v1/compress";
const MIN_CHARS = Number(process.env.SUPERCOMPRESS_HOOK_MIN_CHARS || 400);
const MAX_IN = Number(process.env.SUPERCOMPRESS_HOOK_MAX_CHARS || 180000);

function loadApiKey() {
  const envKey = String(process.env.SUPERCOMPRESS_API_KEY || "").trim();
  if (envKey && !envKey.includes("${") && envKey.startsWith("sc_")) return envKey;
  const configPath = path.join(
    process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(os.homedir(), ".supercompress"),
    "config.json"
  );
  try {
    const key = String(JSON.parse(fs.readFileSync(configPath, "utf8")).api_key || "").trim();
    return key.startsWith("sc_") ? key : null;
  } catch {
    return null;
  }
}

function extractText(toolOutput) {
  if (toolOutput == null) return "";
  if (typeof toolOutput === "string") return toolOutput;
  try {
    return JSON.stringify(toolOutput);
  } catch {
    return String(toolOutput);
  }
}

process.stdin.setEncoding("utf8");
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", async () => {
  const empty = () => process.stdout.write("{}");
  try {
    const input = JSON.parse(raw || "{}");
    const toolName = String(
      input.tool_name ||
        input.toolName ||
        input.tool ||
        (input.tool_input && input.tool_input.name) ||
        ""
    );
    // Skip our own MCP compress calls to avoid loops
    if (/compress_context|connect_account|usage_summary|headroom_/i.test(toolName)) {
      return empty();
    }

    // Cursor: tool_output · Claude Code PostToolUse: tool_response · others: result/output
    let text = extractText(input.tool_output);
    if (!text) text = extractText(input.tool_response);
    if (!text) text = extractText(input.result);
    if (!text) text = extractText(input.output);
    if (!text) text = extractText(input.response);
    if (text.length < MIN_CHARS) return empty();

    const agentHint =
      process.env.SUPERCOMPRESS_AGENT_NAME ||
      (input.session_id || input.cwd ? "Claude Code" : "Cursor");

    const apiKey = loadApiKey();
    if (!apiKey) return empty();

    const clipped = text.length > MAX_IN ? text.slice(0, MAX_IN) : text;
    const query =
      `Compress this ${toolName || "tool"} output for the current coding task. ` +
      "Preserve code, paths, errors, numbers, and decisions.";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let body;
    try {
      const res = await fetch(COMPRESS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({
          context: clipped,
          query,
          mode: "compiler",
          coding_agent: agentHint,
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
        } catch {}
        const paywalled =
          res.status === 402 ||
          code === "free_quota_exhausted" ||
          code === "credits_exhausted" ||
          /PAYWALL|free_quota|credits_exhausted/i.test(detail);
        if (paywalled) {
          const notice = [
            "[SuperCompress PAYWALL] Compression is paused — free 1M tokens used (or credits empty).",
            detail || "Add credits to unlock — $0.30 per 1M tokens after free ($10 minimum load).",
            "Upgrade: https://www.supercompress.dev/dashboard#billing",
          ].join("\n");
          process.stdout.write(JSON.stringify({ additional_context: notice }));
          return;
        }
        return empty();
      }
      body = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const compressed =
      body.compressed_text ||
      body.compressed_context ||
      body.compressed ||
      body.context ||
      body.result ||
      "";
    if (!compressed || typeof compressed !== "string") return empty();

    const inTok = body.original_tokens || body.tokens_in || Math.round(clipped.length / 4);
    const outTok =
      body.kept_tokens ||
      body.compressed_tokens ||
      body.tokens_out ||
      Math.round(compressed.length / 4);
    const saved = body.tokens_saved != null ? body.tokens_saved : Math.max(0, inTok - outTok);
    const pct =
      body.tokens_saved_pct != null
        ? Math.round(body.tokens_saved_pct)
        : body.kv_savings_pct != null
          ? Math.round(body.kv_savings_pct)
          : body.savings_pct != null
            ? body.savings_pct
            : inTok > 0
              ? Math.round((saved / inTok) * 100)
              : 0;

    const additional_context = [
      `[SuperCompress auto] Compressed ${toolName || "tool"} output (~${inTok}→${outTok} tok, −${pct}%).`,
      "Prefer this digest over the raw tool dump:",
      "",
      compressed,
    ].join("\n");

    process.stdout.write(JSON.stringify({ additional_context }));
  } catch {
    empty();
  }
});
