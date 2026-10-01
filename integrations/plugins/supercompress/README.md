# SuperCompress plugin

Query-aware context compression for **Cursor, Claude Code, Codex, Grok Bot**, and other MCP hosts.

Compress tool dumps, logs, diffs, and pasted files before they burn tokens. **64% mean context reduction with 24/24 evidence-retention passes** on the B5 coding-agent benchmark → [benchmarks](https://www.supercompress.dev/benchmarks).

## Easiest path (laptop agents)

```bash
npm install -g supercompress-proxy
supercompress setup          # link account + MCP/hooks on every detected agent
supercompress doctor         # clean health matrix
```

Re-run `supercompress plugin` anytime. Keep your normal Cursor / Claude / Codex login.

## Marketplace / cloud (Grok Bot, Cursor Cloud)

**No MCP OAuth yet.** The hosted URL alone does not open a sign-in prompt.

This plugin tree uses the **hosted** Streamable HTTP MCP (no local `npx`):

`https://www.supercompress.dev/api/mcp`

1. Prefer laptop install: `npm i -g supercompress-proxy && supercompress setup` (browser link + key saved).
2. Or add the SuperCompress plugin (marketplace / this folder) **and** set `SUPERCOMPRESS_API_KEY` (`sc_…` from [dashboard](https://www.supercompress.dev/dashboard)).
3. Call `compress_context` on large dumps.

```
# Claude Code (still needs SUPERCOMPRESS_API_KEY configured after install)
/plugin marketplace add Supercompress/Supercompress
/plugin install supercompress@supercompress

# Codex (same — configure the API key)
codex plugin marketplace add Supercompress/Supercompress
codex plugin add supercompress@supercompress
```

## Tools

| Tool | Purpose |
|------|---------|
| `compress_context` | Compress a dump guided by the user query |
| `connect_account` | Dashboard link to create/copy an API key |
| `usage_summary` | Tokens compressed + quota |

Docs: [docs.supercompress.dev/coding-agents](https://docs.supercompress.dev/coding-agents)
