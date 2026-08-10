#!/usr/bin/env node
/**
 * Claude Code / Codex UserPromptSubmit — compress only *new* pasted CONTEXT.
 * Rolling session memory; compact when large. Never compress the ask.
 */
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
  try {
    const input = JSON.parse(raw || "{}");
    const prompt = String(
      input.prompt || input.user_prompt || input.message || input.content || ""
    );
    const agent =
      process.env.SUPERCOMPRESS_AGENT_NAME ||
      (process.env.TOKEN_OPTIMIZER_RUNTIME === "codex" ? "Codex" : "Claude Code");
    const sessionId = resolveSessionId(input);

    const { ask, context } = splitAskAndContext(prompt);
    if (context.length < MIN_CONTEXT_CHARS) {
      process.stdout.write("{}");
      return;
    }

    const result = await compressIncremental({
      context,
      query: ask || "Compress pasted context for the coding task.",
      codingAgent: agent,
      sessionId,
      kind: "paste",
    });

    if (!result.compressed) {
      process.stdout.write("{}");
      return;
    }
    if (result.skipped === "no_key" || String(result.skipped || "").startsWith("http_")) {
      process.stdout.write("{}");
      return;
    }
    if (result.skipped === "already_seen" && !result.delta) {
      process.stdout.write("{}");
      return;
    }

    const meta = `${result.original_tokens}→${result.compressed_tokens} (−${result.savings_pct}%)${
      result.compacted ? " · compacted" : " · delta-only"
    }`;
    writeInbox(ask, result.compressed, meta, {
      kind: "pasted-context",
      session_id: sessionId,
      compacted: Boolean(result.compacted),
    });

    const additionalContext = [
      `[SuperCompress auto] Compressed new pasted/attached context (~${meta}).`,
      "User ask is unchanged. Prefer this session digest over the raw dump:",
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
