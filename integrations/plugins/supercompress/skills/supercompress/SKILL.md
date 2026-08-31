---
name: supercompress
description: Compress bulky coding-agent context (tool dumps, logs, diffs, files, scrapes) before it burns tokens. Never compress the user's ask. Prefer ~/.supercompress/inbox/latest.md over raw dumps.
---

# SuperCompress

Compress bulky **context**. Never compress the user's current ask / instructions.

## When

Tool dumps, file reads, logs, diffs, RAG chunks, scrapes, pasted blobs, or anything that is not the live user question. Rule of thumb: any single block of non-query context over ~2,000 tokens is worth compressing.

## How

1. If `~/.supercompress/inbox/latest.md` exists, **Read it** — it is a compressed digest of recent bulky context (the ask is unchanged). Session digests may also live at `~/.supercompress/inbox/<sessionId>/latest.md`.
2. Otherwise call the MCP tool `compress_context` (often namespaced `supercompress__compress_context` or exposed via the host's MCP tool picker) with `context`=<the dump> and `query`=<the user's ask>. The query is used to decide what to keep — pass it verbatim.
3. Prefer the digest over re-pasting raw dumps.
4. Account linking: if `compress_context` fails with account-not-linked, call `connect_account` once — it opens a browser sign-in at supercompress.dev, links the account, and stores the key in `~/.supercompress`. Then retry. Free tier: 1M tokens/month; no provider API keys needed.
5. `usage_summary` reports tokens compressed and savings for the linked account.

## Do not

- Compress the user's question / instructions
- Re-paste raw tool dumps after a digest exists
- Skip compression on large dumps "to be safe"
