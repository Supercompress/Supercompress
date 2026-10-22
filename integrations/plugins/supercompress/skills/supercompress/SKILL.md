---
name: supercompress
description: Always-on context compression for coding agents. Use whenever tool output, file reads, logs, diffs, search results, or pasted docs get large (~2K+ tokens): compress them with compress_context, never the user's request. Also check rate-limit runway before large work.
---

# SuperCompress

Compress bulky context before it fills your context window. Never compress the user's request.

## When to compress

Call `compress_context` with `context` = only the new bulky text and `query` = the user's request, verbatim. Compress:

- tool output, logs, stack traces, test and build runs, diffs over ~150 lines (~2K tokens)
- long file reads, grep / search results, web pages, docs, RAG chunks, pasted documents
- earlier conversation you no longer need word for word

Don't compress the user's request, short output, or code you are about to edit or patch — edits need the exact text.

## How

1. If `~/.supercompress/inbox/latest.md` exists, **Read it first** — hooks already compressed the latest large tool result.
2. Otherwise call `compress_context` with only the new dump (not the whole conversation) and work from the returned digest instead of the raw text.
3. If the digest dropped a line you need, re-read just that part of the source.
4. If it says the account is not linked, call `connect_account` once, give the user its link, then retry.
5. `usage_summary` shows tokens saved and remaining quota.

Session digests may also be at `~/.supercompress/inbox/<sessionId>/latest.md`. Tools may be namespaced (`supercompress__compress_context`).

## Rate limits (runway)

Rate-limit runway runs **locally** — it ships in the `supercompress` package (`npx -y supercompress-ai setup`), not on the hosted API, so the hosted MCP has no runway tool. Before large or multi-step work, run:

```bash
supercompress limits --json   # or: npx -y supercompress-ai limits --json
```

If `runway_check` is in your tool list (local MCP from `supercompress setup`), it returns the same answer.

- `go` → proceed. `scope: large` means quota would otherwise go unused at reset, so take on bigger or parallel work.
- `land` → a window is nearly spent. **Keep working**, but commit or write a handoff note before each step so the hard cutoff loses nothing. Don't stop a 5h window at 90%: it resets on its own and unused quota is lost.
- `wait` → a window is actually used up. Checkpoint, then wait `waitMinutes` or switch to a provider in `alternatives`.
- `unknown` → no usage data. Carry on and never guess a limit.

## Don't

- Compress the user's request or instructions.
- Re-paste a raw dump after a digest exists.
- Skip compression on a large dump "to be safe" — the digest keeps what the query needs.
- Switch to provider API-key mode for SuperCompress; normal login is fine.
