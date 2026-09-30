# SuperCompress Agent Plugin

Portable pack for **any** agent that speaks MCP and/or Agent Skills / Agent Plugins.

## Install (easiest)

```bash
npm i -g supercompress-proxy
supercompress setup          # detects Cursor, Claude, Codex, OpenCode, fx, …
supercompress doctor         # verify MCP + hooks per harness
```

Custom / unlisted agent:

```bash
supercompress agents connect
```

## Manual (any MCP client)

After global install:

```json
{
  "command": "supercompress-mcp",
  "args": [],
  "env": { "SUPERCOMPRESS_CONFIG_DIR": "~/.supercompress" }
}
```

Or without a global bin:

```json
{
  "command": "npx",
  "args": ["-y", "supercompress-proxy", "mcp"]
}
```

Tools: `compress_context`, `connect_account`, `usage_summary`.

## Agent Plugins 1.0

This directory is a valid [Agent Plugins](https://agent-plugins.org/) package:

- `plugin.json` — manifest
- `mcp.json` — MCP server
- `skills/supercompress/SKILL.md` — always-on compression skill

```bash
supercompress agents connect --pack ./agent-plugin
```

## fx (Vercel Labs)

`supercompress setup` / `plugin` writes `~/.fx/mcp.json`, `AGENTS.md`, and the skill — then restart fx (or `/mcp reload`).
