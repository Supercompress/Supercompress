# SuperCompress

**SuperCompress v2 — cut ~64% of LLM input tokens for coding agents, without losing the answer.**

~400M Neural Keep on the SuperCompress API scores bulky context (files, logs, tool dumps, pastes) against the current question and drops the rest. Your ask stays intact. This package wires Cursor / Claude Code / Codex / 60+ harnesses into that API via MCP + hooks.

[Website](https://www.supercompress.dev) · [Benchmarks](https://www.supercompress.dev/benchmarks) · [Playground](https://www.supercompress.dev/playground) · [Docs](https://docs.supercompress.dev/coding-agents)

---

## Install

```bash
npm install -g supercompress-proxy
```

Requires Node.js 18+.

---

## Quick start (recommended)

One command links your account and **auto-adds MCP + hooks** across **60+ harnesses** (25+ get a native auto MCP plugin — Cursor, Claude Code, Codex, Goose, Zed, OpenCode, fx, Hermes, OpenClaw, Grok, Gemini, Windsurf, Continue, and more):

```bash
supercompress setup
supercompress doctor
```

Then restart your agent so integrations reload. That’s it.

Re-detect later (new agent installed, etc.):

```bash
supercompress plugin
supercompress agents
supercompress doctor
```

**Any other agent** (custom harness, closed-source, DIY):

```bash
supercompress agents connect
```

That prints a stdio MCP snippet and writes an Agent Plugins 1.0 pack you can drop into any compatible client.
---

## Benchmarks

Same keep-budget (**35% of tokens kept**). Who still has the answer?

| Method | Answer-critical kept |
|---|---:|
| FIFO / truncation | **24.8%** |
| Summarization | **60.5%** |
| H2O | **97.9%** |
| **SuperCompress** | **100%** |

| Metric | Result |
|---|---:|
| Oracle recall (fixed budget) | **100%** |
| Mean token cut (real suite) | **~67%** |
| Important lines kept (compiler) | **100%** |

Full methodology and charts: **[supercompress.dev/benchmarks](https://www.supercompress.dev/benchmarks)**

---

## How it works

```
Your agent ──→ SuperCompress (hooks / MCP) ──→ smaller context ──→ model
                      ↑
                 query stays whole; only context is compressed
```

1. You ask a question (never rewritten).
2. Large context is scored against that question.
3. Evidence-critical lines stay in original wording; filler drops.
4. You pay for fewer input tokens.

---

## Commands

| Command | What it does |
|---------|----------------|
| `supercompress` / `tui` | Interactive paper-branded UI (default in a TTY; [Bun](https://bun.sh)) |
| `supercompress setup` | **Recommended** — link account, detect agents, install MCP + hooks |
| `supercompress plugin` | Refresh agent integrations anytime |
| `supercompress doctor` | Per-harness health matrix (account / MCP / hooks) |
| `supercompress agents` | 60+ catalog — auto-plugin vs recipe/connect |
| `supercompress start` / `stop` / `status` | Optional local proxy (`setup --proxy`) |
| `supercompress usage` | Plan, quota, savings (`--json` ok) |
| `supercompress uninstall` | Remove configs under `~/.supercompress` |

Optional localhost API proxy (base-URL rewrite) if you explicitly need it:

```bash
supercompress setup --proxy
supercompress start
```

Then point OpenAI/Anthropic-compatible clients at `http://localhost:8080/v1`.

---

## MCP

`setup` / `plugin` registers the MCP server on every detected host. You can also run it directly:

```bash
supercompress-mcp
```

Manual registration:

```json
{
  "mcpServers": {
    "supercompress": {
      "command": "supercompress-mcp"
    }
  }
}
```

| Tool | Purpose |
|------|---------|
| `compress_context` | Compress bulky context for a query |
| `connect_account` | Link this install to your dashboard |
| `usage_summary` | Savings for the connected account |

---

## Account & pricing

Launch promo: **5M tokens/month free**, then **$0.10 / 1M** from the [dashboard](https://www.supercompress.dev/dashboard).

---

## Privacy

Hooks / MCP run on your machine. Provider API keys stay with your agent. Context text is sent to the SuperCompress API so the hosted compiler can compress it.

---

## More

- Coding agents: https://docs.supercompress.dev/coding-agents  
- HTTP / Python API: https://docs.supercompress.dev/quickstart  
- Source: https://github.com/Supercompress/Supercompress  

## License

MIT — see [LICENSE](LICENSE).
