# SuperCompress plugin

Query-aware context compression for coding agents, in one install. Compress tool dumps, logs, diffs, and pasted files before they burn tokens — Engine v2 (hosted neural cross-encoder, ~396M params) delivers **64% mean context reduction with 24/24 evidence-retention passes** on the B5 coding-agent benchmark. Details: [supercompress.dev/benchmarks](https://www.supercompress.dev/benchmarks).

One plugin tree, three ecosystems: this directory carries manifests for **Claude Code** (`.claude-plugin/`), **Cursor** (`.cursor-plugin/`), and **Codex** (`.codex-plugin/`).

## What you get

- **MCP server** (`supercompress`) with three tools:
  - `compress_context` — compress a bulky dump, guided by the user's query so the answer survives.
  - `connect_account` — browser sign-in that links the agent to your SuperCompress account (key stored in `~/.supercompress`). Free tier: 1M tokens/month.
  - `usage_summary` — tokens compressed and savings for the linked account.
- **Skill** that teaches the agent when and how to compress (never the user's ask, only bulky context).

## Install

### Claude Code

```
/plugin marketplace add Supercompress/Supercompress
/plugin install supercompress@supercompress
```

### Cursor

Install from the [Cursor Marketplace](https://cursor.com/marketplace) (search "SuperCompress"), or load locally by copying this folder to `~/.cursor/plugins/local/supercompress`.

### Codex

```
codex plugin marketplace add Supercompress/Supercompress
codex plugin add supercompress@supercompress
```

## Account linking

On first compression the agent calls `connect_account`, which opens `supercompress.dev` in your browser. Sign in (or create a free account), and the pairing code links this machine — the API key lands in `~/.supercompress/`. No provider API keys are required and your model login is untouched.

## Going deeper

The plugin uses the hosted API per-call. For always-on compression (prompt-submit and post-tool hooks, local v1 engine fallback, proxy mode), install the full CLI:

```
npx -y supercompress-proxy supercompress setup
```

Docs: [docs.supercompress.dev/coding-agents](https://docs.supercompress.dev/coding-agents) · [supercompress.dev](https://www.supercompress.dev)
