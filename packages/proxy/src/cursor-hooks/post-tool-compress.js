#!/usr/bin/env node
/**
 * Cursor / Claude Code / Codex postToolUse — compress only *new* tool output
 * into session memory. When memory gets large, compact (Headroom-style).
 * Fail-open.
 *
 * Agent attribution: always prefer SUPERCOMPRESS_AGENT_NAME (set by setup for
 * Claude Code / Codex). Cursor hooks omit it — default to "Cursor".
 * Never infer Claude Code from session_id/cwd (Cursor always has those).
 */
const {
  compressIncremental,
  writeInbox,
  resolveSessionId,
} = require("./compress-prompt-lib");

const MIN_CHARS = Number(process.env.SUPERCOMPRESS_HOOK_MIN_CHARS || 400);
const MAX_IN = Number(process.env.SUPERCOMPRESS_HOOK_MAX_CHARS || 180000);

function extractText(toolOutput) {
  if (toolOutput == null) return "";
  if (typeof toolOutput === "string") return toolOutput;
  try {
    return JSON.stringify(toolOutput);
  } catch {
    return String(toolOutput);
  }
}

/** Resolve coding-agent label for usage tracking. */
function resolveAgentHint(input = {}) {
  const envName = String(process.env.SUPERCOMPRESS_AGENT_NAME || "").trim();
  if (envName) return envName;

  // Cursor-specific payload fields
  if (
    input.tool_output != null ||
    input.cursor_version != null ||
    input.generation_id != null ||
    input.model != null
  ) {
    return "Cursor";
  }

  // Installed under ~/.cursor/hooks even when invoked by other agents —
  // without SUPERCOMPRESS_AGENT_NAME, this is Cursor's postToolUse.
  return "Cursor";
}

process.stdin.setEncoding("utf8");
let raw = "";
process.stdin.on("data", (c) => {
  raw += c;
});
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
    if (/compress_context|connect_account|usage_summary|headroom_/i.test(toolName)) {
      return empty();
    }

    // Cursor: tool_output · Claude Code PostToolUse: tool_response · others
    let text = extractText(input.tool_output);
    if (!text) text = extractText(input.tool_response);
    if (!text) text = extractText(input.result);
    if (!text) text = extractText(input.output);
    if (!text) text = extractText(input.response);
    if (text.length < MIN_CHARS) return empty();

    const clipped = text.length > MAX_IN ? text.slice(0, MAX_IN) : text;
    const agentHint = resolveAgentHint(input);
    const sessionId = resolveSessionId(input);

    const query =
      `Compress new ${toolName || "tool"} output for the current coding task. ` +
      "Preserve code, paths, errors, numbers, and decisions.";

    const result = await compressIncremental({
      context: clipped,
      query,
      codingAgent: agentHint,
      sessionId,
      kind: `tool:${toolName || "unknown"}`,
    });

    if (!result.compressed) return empty();
    if (result.skipped === "no_key" || String(result.skipped || "").startsWith("http_")) {
      return empty();
    }
    // Already in memory — don't spam additional_context every identical tool call
    if (result.skipped === "already_seen" && !result.delta) return empty();

    const meta = `${result.original_tokens}→${result.compressed_tokens} (−${result.savings_pct}%)${
      result.compacted ? " · compacted" : " · delta-only"
    }`;
    writeInbox(query, result.compressed, meta, {
      kind: "post-tool",
      session_id: sessionId,
      tool: toolName,
      compacted: Boolean(result.compacted),
    });

    const additional_context = [
      `[SuperCompress auto] Compressed new ${toolName || "tool"} output (~${meta}).`,
      "Prefer this session digest over the raw tool dump:",
      "",
      result.compressed,
    ].join("\n");

    process.stdout.write(JSON.stringify({ additional_context }));
  } catch {
    empty();
  }
});
