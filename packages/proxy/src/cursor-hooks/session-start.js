#!/usr/bin/env node
/**
 * Cursor sessionStart — inject SuperCompress always-on / incremental memory instructions.
 */
process.stdin.setEncoding("utf8");
let raw = "";
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", () => {
  try {
    JSON.parse(raw || "{}");
  } catch {}
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const inbox = `${home}/.supercompress/inbox/latest.md`;
  const additional_context = [
    "SuperCompress is on for this session.",
    `If ${inbox} exists, Read it first: hooks already compressed the latest large tool result.`,
    "Otherwise, before reasoning over bulky new context (tool output, logs, test runs, diffs over ~150 lines, long file reads, search results, docs), call MCP compress_context with only that new text as `context` and the user's request as `query`, then work from the digest.",
    "Never compress the user's request or code you are about to edit. If the digest dropped a line you need, re-read just that part.",
    "Before large or multi-step work, call MCP runway_check: on `land` keep working but checkpoint before each step; only `wait` means stop. Keep Cursor login.",
  ].join(" ");
  process.stdout.write(JSON.stringify({ additional_context }));
});
