---
name: supercompress
description: Compress bulky coding-agent context (tool dumps, logs, diffs, files, scrapes) before it burns tokens. Never compress the user's ask. Prefer ~/.supercompress/inbox/latest.md over raw dumps.
---

# SuperCompress

Compress bulky **context**. Never compress the user's current ask / instructions.

## When

Tool dumps, file reads, logs, diffs, RAG chunks, scrapes, pasted blobs, or anything that is not the live user question. Rule of thumb: any single non-query block over ~2k tokens is worth compressing.

## How

1. If `~/.supercompress/inbox/latest.md` exists, **Read it** — compressed digest (ask unchanged). Session digests may also live at `~/.supercompress/inbox/<sessionId>/latest.md`.
2. Otherwise call MCP `compress_context` (sometimes namespaced `supercompress__compress_context`) with:
   - `context` = the dump
   - `query` = the user's ask (verbatim — never put the ask in `context`)
3. Prefer the digest over re-pasting raw dumps. Keep normal login — no provider API-key mode.
4. If compress fails with account-not-linked → call `connect_account` once, then retry.
5. `usage_summary` reports tokens compressed and remaining quota.

## Hosted / cloud agents (Grok Bot, Cursor Cloud, …)

Use the remote MCP `https://www.supercompress.dev/api/mcp` with `Authorization: Bearer sc_…` (from the dashboard). Same tools: `compress_context`, `connect_account`, `usage_summary`.

## Do not

- Compress the user's question / instructions
- Re-paste raw tool dumps after a digest exists
- Skip compression on large dumps "to be safe"
