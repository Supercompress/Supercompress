#!/usr/bin/env node
/**
 * Cursor beforeSubmitPrompt — Headroom-parity: run on EVERY user submit.
 *
 * Same strategy as the SuperCompress proxy:
 * - last/short user ask = query (never mangled)
 * - attached files + bulky paste / remainder = context → compress
 * - tiny asks with no context → skip (same as proxy context_too_small)
 */
const path = require("path");
const fs = require("fs");
const {
  compressContext,
  writeInbox,
  splitAskAndContext,
} = require("./compress-prompt-lib");

// Align with proxy compressor (~100 words). Override with SUPERCOMPRESS_HOOK_MIN_CHARS.
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
    const result = await compressContext(context, query, "Cursor");
    if (result.paywall || result.skipped === "paywall") {
      const notice = result.notice || "[SuperCompress PAYWALL] Add credits at https://www.supercompress.dev/dashboard#billing";
      writeInbox(query, notice, "paywall", { kind: "paywall" });
      return done({
        additional_context: notice,
        additionalContext: notice,
      });
    }
    if (!result.compressed || result.skipped === "empty" || result.skipped === "too_small") {
      return done();
    }
    if (result.skipped === "no_key" || String(result.skipped || "").startsWith("http_")) {
      return done();
    }

    const meta = result.skipped
      ? `skipped=${result.skipped}`
      : `${result.original_tokens}→${result.compressed_tokens} (−${result.savings_pct}%)`;
    writeInbox(query, result.compressed, meta, { kind: "every-submit" });

    const additional_context = [
      `[SuperCompress auto] Compressed this turn's context (~${meta}).`,
      "User ask unchanged. Prefer this digest over raw dumps/attachments:",
      "",
      result.compressed,
    ].join("\n");

    return done({ additional_context, additionalContext: additional_context });
  } catch {
    return done();
  }
});
