# SuperCompress plugin

Query-aware context compression for **Grok Bot**, Cursor, Claude Code, and Codex.

Compress tool dumps, logs, diffs, and pasted files before they burn tokens. **64% mean context reduction with 24/24 evidence-retention passes** on the B5 coding-agent benchmark. Details: [supercompress.dev/benchmarks](https://www.supercompress.dev/benchmarks).

## Grok Bot (required path)

Grok Bot runs in the cloud — it cannot use local `npx` MCP. This plugin uses the **hosted** Streamable HTTP MCP:

`https://www.supercompress.dev/api/mcp`

### Install in Grok Bot

1. Open **Plugins** in the sidebar → search **SuperCompress** → Add  
   (or load this folder from the Cursor marketplace / local plugins).
2. Open Plugins → SuperCompress → **Configure** and paste your API key (`sc_…`) from [the dashboard](https://www.supercompress.dev/dashboard).
3. Ask the Bot to compress a large dump with `compress_context`.

**Chat install (no marketplace):**

```
Add this MCP server: https://www.supercompress.dev/api/mcp
```

When Grok asks for auth, set header `Authorization: Bearer sc_YOUR_KEY`.

## Cursor / Claude / Codex

Same plugin tree. Cursor Marketplace and local install use the hosted MCP above (works in Cloud Agents and Grok Bot).

```
# Claude Code
/plugin marketplace add Supercompress/Supercompress
/plugin install supercompress@supercompress

# Codex
codex plugin marketplace add Supercompress/Supercompress
codex plugin add supercompress@supercompress
```

For always-on local hooks (prompt-submit / post-tool) on your laptop, also run:

```
npx -y supercompress-proxy supercompress setup
```

## Tools

- `compress_context` — compress a bulky dump, guided by the user's query
- `connect_account` — dashboard link to create/copy an API key
- `usage_summary` — tokens compressed and quota

## Account

Create a free account at [supercompress.dev/dashboard](https://www.supercompress.dev/dashboard), copy an API key (`sc_…`), and set `SUPERCOMPRESS_API_KEY` on the plugin. Free tier includes monthly tokens; see the dashboard for launch pricing.

Docs: [docs.supercompress.dev/coding-agents](https://docs.supercompress.dev/coding-agents)
