#!/usr/bin/env node
/**
 * Claude Code / Codex UserPromptSubmit — compress pasted CONTEXT, never the ask.
 *
 * If the user pasted a huge dump with a short ask, we treat the ask as query and
 * compress only the bulky remainder. Short prompts alone are left alone.
 */
const { compressContext, writeInbox, splitAskAndContext } = require("./compress-prompt-lib");

const MIN_CONTEXT_CHARS = Number(process.env.SUPERCOMPRESS_HOOK_MIN_CHARS || 400);

process.stdin.setEncoding("utf8");
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", async () => {
  try {
    const input = JSON.parse(raw || "{}");
    const prompt = String(
      input.prompt ||
        input.user_prompt ||
        input.message ||
        input.content ||
        ""
    );
    const agent =
      process.env.SUPERCOMPRESS_AGENT_NAME ||
      (process.env.TOKEN_OPTIMIZER_RUNTIME === "codex" ? "Codex" : "Claude Code");

    const { ask, context } = splitAskAndContext(prompt);
    if (context.length < MIN_CONTEXT_CHARS) {
      // Just the user's ask (or tiny paste) — do not compress
      process.stdout.write("{}");
      return;
    }

    const result = await compressContext(context, ask || "Compress pasted context for the coding task.", agent);
    if (result.paywall || result.skipped === "paywall") {
      const notice = result.notice || "[SuperCompress PAYWALL] Add credits at https://www.supercompress.dev/dashboard#billing";
      writeInbox(ask, notice, "paywall", { kind: "paywall" });
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: notice,
          },
          additionalContext: notice,
          additional_context: notice,
        })
      );
      return;
    }
    if (!result.compressed || result.skipped === "empty" || result.skipped === "too_small") {
      process.stdout.write("{}");
      return;
    }
    if (result.skipped === "no_key" || String(result.skipped || "").startsWith("http_")) {
      process.stdout.write("{}");
      return;
    }

    const meta = result.skipped
      ? `skipped=${result.skipped}`
      : `${result.original_tokens}→${result.compressed_tokens} (−${result.savings_pct}%)`;
    writeInbox(ask, result.compressed, meta, { kind: "pasted-context" });

    const additionalContext = [
      `[SuperCompress auto] Compressed pasted/attached context (~${meta}).`,
      "User ask is unchanged. Prefer this digest over the raw dump:",
      "",
      result.compressed,
    ].join("\n");

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext,
        },
        additionalContext,
        additional_context: additionalContext,
      })
    );
  } catch {
    process.stdout.write("{}");
  }
});
