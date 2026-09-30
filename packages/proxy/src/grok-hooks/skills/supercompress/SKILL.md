---
name: supercompress
description: Always-on context compression for Grok Build. Use when tool dumps, file reads, logs, diffs, scrapes, or pasted blobs are large. Compress bulky context via MCP supercompress__compress_context; never compress the user's ask. Prefer the PostToolUse-replaced tool result or ~/.supercompress/inbox/latest.md over raw dumps.
---

# SuperCompress (Grok Build)

Compress bulky **context** (tool dumps, files, logs, diffs, history). Never compress the user's ask/query.

## Grok-specific

- Global hooks in `~/.grok/hooks/supercompress.json` auto-compress large `PostToolUse` results.
- On Grok, the hook **replaces the model's copy** of the tool result (`updatedToolOutput`) with the digest. The scrollback keeps the original.
- Digests are also written to `~/.supercompress/inbox/latest.md` (and `inbox/<sessionId>/`).
- Grok discards `UserPromptSubmit` `additionalContext`, so do not wait for the next prompt to see the digest — it is already in the tool result when the hook succeeds.
- After a big `run_terminal_command` / `read_file` / MCP dump: use the replaced result, or **Read** the inbox, or call `supercompress__compress_context` before answering from a raw dump.

## How

1. Prefer the PostToolUse-replaced tool result when present.
2. Else if `~/.supercompress/inbox/latest.md` exists, **Read it** — compressed digest (ask is unchanged). Session digests may also be at `~/.supercompress/inbox/<sessionId>/latest.md`.
3. Otherwise call MCP `supercompress__compress_context` with `context`=<new dump> and `query`=<user ask>.
4. If that tool is not in your native tool list, `search_tool` then `use_tool` with `supercompress__compress_context`. Related: `supercompress__connect_account`, `supercompress__usage_summary`.
5. Prefer the digest over raw dumps. Keep normal login — no provider API-key mode required.
6. If compress_context fails with account-not-linked, call `connect_account` once, then retry.

## Do not

- Compress the user's question / instructions.
- Re-paste raw tool dumps after a digest or replaced result exists.
