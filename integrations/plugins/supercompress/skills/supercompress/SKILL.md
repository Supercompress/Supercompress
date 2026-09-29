---
name: supercompress
description: Compress bulky context (tool dumps, logs, diffs, files, scrapes) before it burns tokens. Never compress the user's ask. Use on Grok Bot and other agents via the SuperCompress MCP plugin.
---

# SuperCompress

Compress bulky **context**. Never compress the user's current ask / instructions.

## When

Tool dumps, browser scrapes, file reads, logs, diffs, RAG chunks, pasted blobs, or anything that is not the live user question. Rule of thumb: any single block of non-query context over ~2,000 tokens is worth compressing.

## How (Grok Bot + remote MCP)

1. Call MCP `compress_context` with `context`=<the dump> and `query`=<the user's ask>. The query guides what to keep — pass it verbatim; never put the ask in `context`.
2. Prefer the returned `compressed_context` digest over re-pasting the raw dump.
3. If the tool says you are not connected: call `connect_account`, open the dashboard link, copy an API key (`sc_…`), then set it under Plugins → SuperCompress → Configure (`SUPERCOMPRESS_API_KEY`). Retry.
4. Or tell the Bot: `Add this MCP server: https://www.supercompress.dev/api/mcp` and supply `Authorization: Bearer sc_…` when prompted.
5. `usage_summary` reports tokens compressed and remaining quota.

## Do not

- Compress the user's question / instructions
- Re-paste raw dumps after a digest exists
- Skip compression on large dumps "to be safe"
