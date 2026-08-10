#!/usr/bin/env node
/**
 * Cursor beforeSubmitPrompt — Headroom-parity incremental compress.
 *
 * - last/short user ask = query (never mangled)
 * - only *new* attached/pasted context is compressed
 * - rolling session memory; compact when it gets big
 */
const path = require("path");
const fs = require("fs");
const {
  compressIncremental,
  writeInbox,
  splitAskAndContext,
  resolveSessionId,
} = require("./compress-prompt-lib");

const MIN_CONTEXT_CHARS = Number(process.env.SUPERCOMPRESS_HOOK_MIN_CHARS || 400);

process.stdin.setEncoding("utf8");
let raw = "";
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", async () => {
  const done = (extra = {}) => {
    process.stdout.write(JSON.stringify({ continue: true, ...extra }));
  };
  try {
    const input = JSON.parse(raw || "{}");
    const prompt = String(input.prompt || "").trim();
    const attachments = Array.isArray(input.attachments) ? input.attachments : [];
    const sessionId = resolveSessionId(input);

    let attachText = "";
    for (const a of attachments.slice(0, 12)) {
      const fp = a.file_path || a.path;
      if (!fp) continue;
      try {
        if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
          const txt = fs.readFileSync(fp, "utf8");
          attachText += `\n\n[attachment ${path.basename(fp)}]\n${txt.slice(0, 40000)}`;
        }
      } catch {}
    }

    const { ask, context: pasteCtx } = splitAskAndContext(prompt);
    const context = `${pasteCtx}\n${attachText}`.trim();

    if (context.length < MIN_CONTEXT_CHARS) {
      return done();
    }

    const query = ask || prompt || "Compress context for the current coding task.";
    const result = await compressIncremental({
      context,
      query,
      codingAgent: "Cursor",
      sessionId,
      kind: "submit",
    });

    if (!result.compressed) return done();
    if (result.skipped === "no_key" || String(result.skipped || "").startsWith("http_")) {
      return done();
    }

    const meta =
      result.skipped === "already_seen"
        ? `memory replay · session ${sessionId}`
        : `${result.original_tokens}→${result.compressed_tokens} (−${result.savings_pct}%)${
            result.compacted ? " · compacted" : " · delta-only"
          }`;

    writeInbox(query, result.compressed, meta, {
      kind: result.skipped === "already_seen" ? "session-memory" : "every-submit",
      session_id: sessionId,
      compacted: Boolean(result.compacted),
    });

    const additional_context = [
      `[SuperCompress auto] ${
        result.skipped === "already_seen"
          ? "Session memory (no new context this turn)."
          : `Compressed new context only (~${meta}).`
      }`,
      "User ask unchanged. Prefer this digest over raw dumps/attachments:",
      "",
      result.compressed,
    ].join("\n");

    return done({ additional_context, additionalContext: additional_context });
  } catch {
    return done();
  }
});
