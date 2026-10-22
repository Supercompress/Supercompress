---
name: supercompress
description: Always-on context compression for Grok Build. Use whenever tool output, file reads, logs, diffs, or pasted docs get large: use the PostToolUse-replaced result or ~/.supercompress/inbox/latest.md, else supercompress__compress_context. Never compress the user's request. Check rate-limit runway before large work.
---

# SuperCompress (Grok Build)

Compress bulky context before it fills your context window. Never compress the user's request.

## Grok-specific

- Global hooks in `~/.grok/hooks/supercompress.json` auto-compress large `PostToolUse` results.
- On Grok, the hook **replaces the model's copy** of the tool result (`updatedToolOutput`) with the digest. The scrollback keeps the original.
- Digests are also written to `~/.supercompress/inbox/latest.md` (and `inbox/<sessionId>/`).
- Grok discards `UserPromptSubmit` `additionalContext`, so don't wait for the next prompt — the digest is already in the tool result when the hook succeeds.
- If a tool isn't in your native list, `search_tool` then `use_tool` with its `supercompress__…` name.

## When to compress

Call `supercompress__compress_context` with `context` = only the new bulky text and `query` = the user's request, verbatim. Compress:

- tool output, logs, stack traces, test and build runs, diffs over ~150 lines (~2K tokens)
- long file reads, grep / search results, web pages, docs, RAG chunks, pasted documents
- earlier conversation you no longer need word for word

Don't compress the user's request, short output, or code you are about to edit or patch — edits need the exact text.

## How

1. Prefer the PostToolUse-replaced tool result when present.
2. If `~/.supercompress/inbox/latest.md` exists, **Read it first** — hooks already compressed the latest large tool result.
3. Otherwise call `supercompress__compress_context` with only the new dump (not the whole conversation) and work from the returned digest instead of the raw text.
4. If the digest dropped a line you need, re-read just that part of the source.
5. If it says the account is not linked, call `supercompress__connect_account` once, give the user its link, then retry.

## Rate limits (runway)

Before large or multi-step work, call `supercompress__runway_check` (or run `supercompress limits --json`). It runs locally and reads Codex session limits, Claude Code statusline limits, and provider rate-limit headers seen by the local proxy.

- `go` → proceed. `scope: large` means quota would otherwise go unused at reset, so take on bigger or parallel work.
- `land` → a window is nearly spent. **Keep working**, but commit or write a handoff note before each step so the hard cutoff loses nothing. Don't stop a 5h window at 90%: it resets on its own and unused quota is lost.
- `wait` → a window is actually used up. Checkpoint, then wait `waitMinutes` or switch to a provider in `alternatives`.
- `unknown` → no usage data. Carry on and never guess a limit.

## Don't

- Compress the user's request or instructions.
- Re-paste a raw dump after a digest exists.
- Skip compression on a large dump "to be safe" — the digest keeps what the query needs.
- Switch to provider API-key mode for SuperCompress; normal login is fine.
