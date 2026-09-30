#!/usr/bin/env node
/**
 * Claude Code / Codex / Grok UserPromptSubmit — compress only *new* pasted CONTEXT.
 * Rolling session memory; compact when large. Never compress the ask.
 *
 * Grok Build discards UserPromptSubmit additionalContext. The live mid-turn
 * path for Grok is PostToolUse updatedToolOutput (see post-tool-compress.js).
 * Inbox digest inject here remains a best-effort fallback for other hosts.
 */
const {
  compressIncremental,
  writeInbox,
  splitAskAndContext,
  resolveSessionId,
  shouldPublishCompressedResult,
  readFreshInboxDigest,
} = require("./compress-prompt-lib");

const MIN_CONTEXT_CHARS = Number(process.env.SUPERCOMPRESS_HOOK_MIN_CHARS || 400);
const DIGEST_INJECT_MAX = Number(process.env.SUPERCOMPRESS_DIGEST_INJECT_MAX || 100_000);

function emitAdditionalContext(additionalContext) {
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
}

function isGrokAgent(name) {
  return /grok/i.test(String(name || ""));
}

process.stdin.setEncoding("utf8");
let raw = "";
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", async () => {
  try {
    const input = JSON.parse(raw || "{}");
    const prompt = String(
      input.prompt ||
        input.user_prompt ||
        input.userPrompt ||
        input.message ||
        input.content ||
        input.text ||
        ""
    );
    const agent =
      process.env.SUPERCOMPRESS_AGENT_NAME ||
      (process.env.TOKEN_OPTIMIZER_RUNTIME === "codex" ? "Codex" : "Claude Code");
    const sessionId = resolveSessionId(input) || process.env.GROK_SESSION_ID || null;

    const { ask, context } = splitAskAndContext(prompt);
    if (context.length >= MIN_CONTEXT_CHARS) {
      const result = await compressIncremental({
        context,
        query: ask || "Compress pasted context for the coding task.",
        codingAgent: agent,
        sessionId,
        kind: "paste",
      });

      if (
        result.compressed &&
        shouldPublishCompressedResult(result) &&
        !(result.skipped === "already_seen" && !result.delta)
      ) {
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
        emitAdditionalContext(additionalContext);
        return;
      }
    }

    // Grok: PostToolUse cannot inject additionalContext — surface the latest
    // auto-compress digest on the next user prompt so the model actually sees it.
    if (isGrokAgent(agent) || process.env.SUPERCOMPRESS_INJECT_DIGEST === "1") {
      const digest = readFreshInboxDigest(sessionId);
      if (digest) {
        const clipped =
          digest.length > DIGEST_INJECT_MAX
            ? `${digest.slice(0, DIGEST_INJECT_MAX)}\n\n…[digest truncated for hook inject]`
            : digest;
        emitAdditionalContext(
          [
            "[SuperCompress auto] Latest compressed tool/context digest (prefer over raw dumps).",
            "User ask is unchanged.",
            "",
            clipped,
          ].join("\n")
        );
        return;
      }
    }

    process.stdout.write("{}");
  } catch {
    process.stdout.write("{}");
  }
});
