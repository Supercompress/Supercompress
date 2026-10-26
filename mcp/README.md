# SuperCompress MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets any MCP-compatible agent (Claude Desktop, Claude Code, Cursor, Windsurf, etc.) compress long context before sending it to an LLM.

**No API key needed for local compression** — runs entirely on your machine using the same compression engine as the hosted API.

## Tools

| Tool | Description |
|------|-------------|
| `compress` | Compress a long text context before LLM inference. Removes low-value tokens while preserving query-critical evidence |
| `retrieve` | Retrieve original text removed during CCR compression using a `[SC-Retrieve: hash]` marker |
| `simple_hash` | Compute the content-addressed hash for a given text |

## Setup

### 1. Install dependencies

```bash
cd /path/to/supercompress
npm install
```

### 2. Configure your MCP client

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "supercompress": {
      "command": "node",
      "args": ["/absolute/path/to/supercompress/mcp/server.js"]
    }
  }
}
```

**Claude Code** — add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "supercompress": {
      "command": "node",
      "args": ["/absolute/path/to/supercompress/mcp/server.js"]
    }
  }
}
```

**Cursor** — add in Cursor Settings → MCP Servers:

```
Name: supercompress
Type: command
Command: node /absolute/path/to/supercompress/mcp/server.js
```

### 3. Restart your MCP client

The client will launch the SuperCompress server automatically. You should see the tools appear in the available tools list.

## Usage

The `query` is optional in both the legacy local `compress` tool and the
hosted/installed `compress_context` tool. Omit it (or pass an empty string) for
a raw dump; provide the user's task verbatim when query-focused compression is
wanted. Only `context` is required.

Compression returns the original context with a warning when the candidate is
empty, grows in characters, or saves less than 5% of estimated tokens. It also
bypasses suspicious large-input collapses (at least 1,000 estimated input tokens,
over 99% discarded, and at most 64 estimated output tokens). These are
conservative heuristics, not semantic-preservation verification or model-token
measurements. Delivered-text counters include cache/retrieval decoration.

MCP responses preserve API `warnings`, `compression_safety`, and bypass reasons
as metadata, not text added to the digest. The installed MCP does not append a
bypassed dump to rolling memory or wrap it in session headings. A bypassed or
growing compaction leaves existing memory intact.

Hosted and installed MCP report quota and billing warnings only from returned
account fields such as `free_tokens_remaining`, `credit_wallet`,
`credit_balance_usd`, and explicit exhaustion codes. An exhausted free allowance
does not imply prepaid credit is exhausted. Missing fields mean quota status is
unknown, not unlimited or free. Successful compression needs an API accounting
snapshot to provide a current quota warning; `usage_summary` also reports the
account fields. No extra per-compression usage request is made. The legacy local
engine does not supply hosted billing information.

The standalone MCP response formatter in `api/_lib/mcp-response.js` is mirrored
in `packages/proxy/src/mcp-response.js` for separate API/package deployments;
`api/_lib/mcp-safety.test.js` checks byte parity and isolated module loading.

### Compress context (compiler mode)

The agent calls this automatically when it needs to fit long context into a window. You can also invoke it directly:

```
Use the compress tool with:
- context: [paste long text]
- query: "What does this code do?"
```

### Compress with CCR (reversible)

CCR replaces dropped blocks with `[SC-Retrieve: hash]` markers so the original text can be restored later.

```
Use the compress tool with:
- context: [paste long text]
- query: "What's the root cause?"
- mode: "ccr"
```

### Retrieve original text

When a compressed output contains a `[SC-Retrieve: a1b2c3d4_2f]` marker:

```
Use the retrieve tool with:
- hash: "a1b2c3d4_2f"
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPERCOMPRESS_API_KEY` | No | Enables hosted API fallback for `retrieve` when the local cache doesn't have the hash |

## How it works

1. The MCP server launches as a stdio subprocess managed by your MCP client
2. `compress` loads the trained model (`web/assets/data/model.json`) and runs the same compiler engine as `supercompress.dev`
3. `retrieve` checks an in-memory LRU cache first, then optionally falls back to the hosted API
4. The cache is ephemeral — it persists for the current session only

## Files

| Path | Purpose |
|------|---------|
| `mcp/server.js` | MCP server implementation |
| `api/_lib/engine.js` | Shared compression engine (also used by the Vercel API) |
| `web/assets/js/compress-engine.js` | Browser-side engine (loaded into VM sandbox by the server) |
| `web/assets/data/model.json` | Trained model weights |
