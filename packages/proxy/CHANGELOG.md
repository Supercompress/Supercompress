## 0.5.12

- Harden device-link pairing codes to 128-bit entropy.

# Changelog

Versions track `supercompress-proxy` on npm. Full product notes: [CHANGELOG.md](../../CHANGELOG.md) · [GitHub Releases](https://github.com/Supercompress/Supercompress/releases)

## Unreleased

- **Fix `uninstall` leaving artifacts behind**: it reported success while the Cursor rule, Cursor hook scripts and hook registrations, and the agent instruction blocks (`CLAUDE.md` / `AGENTS.md` / …) all survived. `revertAll` only walked the provider base-URL configs, and the three writers responsible never recorded a backup. Uninstalling now removes them and reports each one, preserving unrelated Cursor hooks and user-authored instruction content. Installs from earlier versions clean up too.

## 0.5.11 — 2026-08-07

- **CLI `account` / `usage`**: show linked account, plan/quota, and per-agent token savings (`supercompress usage [--json]`).
- Louder **paywall** handling in the proxy compressor (402 / free quota / credits exhausted) with correct **$0.30 / 1M** copy.
- Hooks/MCP compress requests pass `source` + `session_id` for better activity attribution; clearer timeout vs error skip reasons.

## 0.5.10 — 2026-08-05

- **Fix device connect hang**: reconnect no longer fails silently when the account is at the API-key plan limit. `connect-device` rotates prior Coding agent / CLI keys and mints a fresh one.
- Dashboard shows linking / connected / retry banner; keeps `?connect=` on failure so Retry works.
- CLI `setup` / `connect`: www URL, longer wait, progress ticks, paste-key fallback after timeout.

## 0.5.9 — 2026-08-05

- **Fast global install**: drop `@modelcontextprotocol/sdk` + `node-fetch` (was ~100 transitive packages / ~27MB). MCP is a tiny zero-dep stdio JSON-RPC server; uses Node 18+ `fetch`. Fixes `npm install -g supercompress-proxy` hangs/timeouts on slow registries.
- **Hermes auto-compress**: shell hooks (`pre_llm_call` / `post_tool_call`), `transform_tool_result` plugin, native `compression` + `proactive_prune_tokens`, absolute MCP launch path, idempotent `AGENTS.md`.
- **Hermes + OpenClaw MCP**: auto-wire `~/.hermes/config.yaml` (`mcp_servers`) and `~/.openclaw/openclaw.json` (`mcp.servers`); also `~/.mcporter/mcporter.json` when present.
- **Pluggable custom agents**: `supercompress agents add|rm` + `~/.supercompress/agent-plugins.json` / `plugins/*.json` (formats: mcp-json, hermes-yaml, openclaw-json, opencode-json, codex-toml, instruction-only).
- `supercompress mcp-check` verifies the MCP server lists `compress_context` / `connect_account` / `usage_summary`.
- Incremental session memory in hooks + MCP (`compress_context`): compress only new chunks; compact when memory grows large.
- Prefer `tokens_saved_pct` for prompt-token savings while accepting the deprecated `kv_savings_pct` response alias.
- Correct the package README license statement: SuperCompress is MIT licensed and permits commercial use.

## 0.5.8 — 2026-08-02

- **Headroom-parity every-submit compress**: Cursor `beforeSubmitPrompt` + Claude/Codex `UserPromptSubmit` compress context on every message that has real context; tiny asks (~&lt;400 chars / ~100 words) skip — same floor as the proxy.
- User ask stays the query (never mangled); pasted/attached/tool context is compressed into `~/.supercompress/inbox/latest.md` + `additional_context`.
- Tool-dump hook threshold lowered from 800 → 400 chars to match.

## 0.5.7 — 2026-08-01

- Auto MCP install across detected agents (Cursor, Claude, Codex, OpenCode, FreeBuff, Windsurf, Continue, Gemini, Goose, Crush, Amp, Zed, Copilot, Roo, Cline, …).
- Claude Code + Codex: `UserPromptSubmit` + `PostToolUse` hooks for every-message and tool-dump compression.
- Always-on instruction files (CLAUDE.md / AGENTS.md / …) when those agents are present.
- New `supercompress wrap <agent>` — Headroom-style proxy wrap for full-traffic auto-compress.

## 0.5.6 — 2026-07-31

- Every-message compress threshold lowered (compress prompts ≥40 chars; tiny ones still write inbox).

## 0.5.5 — 2026-07-31

- **Every-message auto-compress**: IDE `beforeSubmitPrompt` writes `~/.supercompress/inbox/latest.md` on every submit; Claude Code + Codex `UserPromptSubmit` inject compressed digests; `postToolUse` threshold lowered to 800 chars.
- Always-on agent rule forces Read of inbox digest first every turn.

## 0.5.4 — 2026-07-28

- OpenCode MCP: write `enabled: true`, `timeout: 60000`, and `experimental.mcp_timeout` (OpenCode’s default tool-fetch timeout is 5s). Prefer `supercompress-mcp` on PATH over a baked absolute Node path.

## 0.5.3 — 2026-07-28

- Harden MCP stdio server against `-32000: Connection closed`: catch unhandled errors, keep process alive on tool failures, timeouts on API calls, stderr-only logging, drop unused elicitation capability.

## 0.5.2 — 2026-07-26

- Ship LICENSE + CHANGELOG in the npm tarball.

## 0.5.1 — 2026-07-26

- **postinstall is guidance-only** — no longer rewrites agent MCP configs on `npm install`. Use `supercompress setup` or `supercompress plugin`.
- **FreeBuff dual-launch** — MCP compress handshake waits for tool responses (no early timeout flake).
- Docs/README aligned with MCP-first install path; agent catalog count 49.

## 0.5.0 — 2026-07-26

- MCP-first coding-agent plugin (`compress_context`, `connect_account`, `usage_summary`).
- Optional localhost API proxy via `supercompress setup --proxy`.
- Hard launch of SuperCompress coding agent integrations (Cursor, Claude Code, Codex, and more).
