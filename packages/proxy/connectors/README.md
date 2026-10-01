# SuperCompress Connectors

Clean install recipes for every harness and app SDK we support.

**Connector** = one named integration (Cursor, Claude Code, Goose, Vercel AI SDK, …).  
Not a blob of “plugins.” Each card is copy-paste install + where config lands.

## Use

```bash
npm i -g supercompress-proxy

supercompress connectors              # list
supercompress connector cursor        # one clean card
supercompress connector vercel-ai-sdk
supercompress setup && supercompress plugin   # auto-wire detected harnesses
```

## Kinds

| Kind | Meaning |
|------|---------|
| **Auto MCP** | `setup` / `plugin` writes native MCP (+ hooks when the host supports it) |
| **App / SDK** | Drop-in middleware under `integrations/` |
| **Recipe** | `agents connect` — paste stdio MCP into any client |

## Everyday posts

Pick one connector id. Show the card. Post the harness name + one-liner. No automation required:

```bash
supercompress connector cursor
```
