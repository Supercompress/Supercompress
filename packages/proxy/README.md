# SuperCompress

**SuperCompress v2 — cut ~64% of LLM input tokens for coding agents, without losing the answer.**

~400M Neural Keep on the SuperCompress API scores bulky context (files, logs, tool dumps, pastes) against the current question and drops the rest. Your ask stays intact. This package wires Cursor / Claude Code / Codex / 40+ harnesses into that API via MCP + hooks.

[Website](https://www.supercompress.dev) · [Benchmarks](https://www.supercompress.dev/benchmarks) · [Playground](https://www.supercompress.dev/playground) · [Docs](https://docs.supercompress.dev/coding-agents)

---

## Install

```bash
npm install -g supercompress-proxy
```

Requires Node.js 18+.

---

## Quick start (recommended)

One command links your account and **auto-adds MCP + hooks** across **40+ harnesses** (25+ get a native auto MCP plugin — Cursor, Claude Code, Codex, Goose, Zed, OpenCode, fx, Hermes, OpenClaw, Grok Build, **Grok Bot** (hosted MCP URL), Gemini, Windsurf, Continue, and more):

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
| `supercompress agents` | 40+ catalog — auto-plugin vs recipe/connect |
| `supercompress start` / `stop` / `status` | Optional local proxy (`setup --proxy`) |
| `supercompress usage` | Plan, quota, savings (`--json` ok) |
| `supercompress limits` | Provider rate-limit runway — 5h / weekly windows (`--json` for agents) |
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
| `runway_check` | Provider rate-limit runway (local, no account needed) |

---

## Runway (rate limits)

`supercompress limits --json` / MCP `runway_check` tell the agent how much provider quota is left and what to do with it. Built from [limitcheck](https://github.com/arjunkshah12345-hash/limitcheck), extended to every harness SuperCompress plugs into. Runway runs **locally, inside this package**; your usage data never goes through the hosted API, and the hosted MCP has no runway tool. Each check (`limits` status or `runway_check`, not the statusline) sends one anonymous count to the public total at [limitcheck.supercompress.dev](https://limitcheck.supercompress.dev/live): just the verdict (`go` / `land` / `pace` / `wait` / `unknown`) and `cli` or `mcp`. No ids, usage numbers, prompts or paths. Opt out with `SUPERCOMPRESS_TELEMETRY=0`, `DO_NOT_TRACK=1` or `SUPERCOMPRESS_RUNWAY=0`. `setup` / `plugin` install it automatically: they add the runway rule to every agent's instructions and skill, register `runway_check` on the local MCP, copy a standalone runtime to `~/.supercompress/runway/`, and connect Claude Code's statusline. `uninstall` reverses all of it.

| Source | Harnesses |
|--------|-----------|
| `~/.codex/sessions` rate-limit events (zero config) | Codex |
| Statusline tee, wired by `setup` (or `supercompress limits connect claude-code`). Your own statusline keeps working unchanged | Claude Code |
| Upstream rate-limit headers seen by the local proxy (Anthropic, OpenAI, xAI, OpenRouter, Codex) | Any harness routed through `localhost:8080` (Aider, Continue, Cline, OpenCode, Goose, …) |
| `supercompress limits ingest --provider <id>` (stdin JSON) / `SUPERCOMPRESS_LIMITS_SNAPSHOT` / `LIMITCHECK_SNAPSHOT` | Anything else (Cursor, Windsurf, Grok Build, Gemini CLI, custom hooks) |

Actions: `go` (with `scope`), `land` (keep working, checkpoint before each step), `pace` (balanced policy only), `wait` (actually exhausted — `waitMinutes`, `alternatives`), `unknown` (no source; never invented).

The default `max` policy uses a 5h window all the way to the provider's cutoff instead of stopping at a fixed 10% floor: short windows reset on their own, so unused quota is wasted. Weekly/monthly windows are judged by pace (remaining % vs time left). `--policy conservative` keeps limitcheck's 25% / 10% thresholds. In a seeded simulation (`node test/runway-sim.js`) `max` uses 100% of a binding 5h window vs 91.5%, for +7.8% completed steps, and checkpoints before 59 of 60 cutoffs. `SUPERCOMPRESS_RUNWAY=0` stops `setup` from touching the statusline and disables proxy header capture. Only rate-limit numbers are stored (`~/.supercompress/limits/`), never prompts or responses.

---

## Account & pricing

**1M tokens/month free**, then **$0.10 / 1M** from the [dashboard](https://www.supercompress.dev/dashboard).

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
