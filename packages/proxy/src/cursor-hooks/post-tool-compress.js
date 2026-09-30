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
  shouldPublishCompressedResult,
} = require("./compress-prompt-lib");
const {
  isGrokAgent,
  buildGrokHookResponse,
} = require("./grok-post-tool");

const MIN_CHARS = Number(process.env.SUPERCOMPRESS_HOOK_MIN_CHARS || 400);
/** Soft total cap — shared lib chunks to API 120k (do not pre-clip to 180k). */
const MAX_IN = Number(process.env.SUPERCOMPRESS_HOOK_MAX_CHARS || 1_200_000);

function extractText(toolOutput) {
  if (toolOutput == null) return "";
  if (typeof toolOutput === "string") return toolOutput;
  try {
    return JSON.stringify(toolOutput);
  } catch {
    return String(toolOutput);
  }
}

/** Prefer concrete symbols/paths over a generic "preserve everything" ask. */
function buildToolCompressQuery(toolName, text) {
  const sample = String(text || "").slice(0, 12000);
  const focus = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (!s || s.length < 3 || s.length > 80) return;
    if (!focus.includes(s)) focus.push(s);
  };
  for (const m of sample.match(/(?:^|[\s"'`(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7})/g) || []) {
    push(m.replace(/^[\s"'`(]+/, ""));
  }
  for (const m of sample.match(
    /\b(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|def|fn|func)\s+([A-Za-z_][\w]*)/g
  ) || []) {
    push(m.replace(/^[\s\S]*\s/, ""));
  }
  for (const m of sample.match(/\b([A-Z][A-Z0-9_]{3,})\b/g) || []) {
    if (!/^(HTTP|JSON|HTML|CSS|UTF|NULL|TRUE|FALSE|WARN|INFO|ERROR|DEBUG)$/.test(m)) push(m);
  }
  const tool = String(toolName || "tool").trim() || "tool";
  const base =
    `Coding-agent ${tool} output. Keep stack traces, errors, file contents, ` +
    "return values, and symbols needed for the current task.";
  if (!focus.length) return base;
  return `${base} Focus: ${focus.slice(0, 12).join(", ")}`;
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

function emitGrokReplacement(opts) {
  process.stdout.write(JSON.stringify(buildGrokHookResponse(opts)));
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
        (input.toolInput && input.toolInput.name) ||
        ""
    );
    if (/compress_context|connect_account|usage_summary|headroom_/i.test(toolName)) {
      return empty();
    }

    // Cursor: tool_output · Claude: tool_response · Grok: toolResult (camelCase)
    let text = extractText(input.tool_output);
    if (!text) text = extractText(input.tool_response);
    if (!text) text = extractText(input.toolResult);
    if (!text) text = extractText(input.tool_result);
    if (!text) text = extractText(input.result);
    if (!text) text = extractText(input.output);
    if (!text) text = extractText(input.response);
    if (text.length < MIN_CHARS) return empty();

    const bounded = text.length > MAX_IN ? text.slice(0, MAX_IN) : text;
    const agentHint = resolveAgentHint(input);
    const sessionId = resolveSessionId(input);

    const query = buildToolCompressQuery(toolName, bounded);

    const result = await compressIncremental({
      context: bounded,
      query,
      codingAgent: agentHint,
      sessionId,
      kind: `tool:${toolName || "unknown"}`,
    });

    if (!result.compressed) return empty();
    if (!shouldPublishCompressedResult(result)) return empty();
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

    // Grok: UserPromptSubmit discards additionalContext. PostToolUse can
    // replace the model's tool result (updatedToolOutput) — that is the path
    // that actually makes digests visible mid-turn.
    if (isGrokAgent(agentHint)) {
      emitGrokReplacement({
        toolResult: input.toolResult != null ? input.toolResult : input.tool_response,
        toolResultTruncated: Boolean(input.toolResultTruncated || input.tool_result_truncated),
        toolName,
        meta,
        compressed: result.compressed,
      });
      return;
    }

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
