# Changelog

Versions track `supercompress-proxy` on npm. Full product notes: [CHANGELOG.md](../../CHANGELOG.md) · [GitHub Releases](https://github.com/Supercompress/Supercompress/releases)

## [Unreleased]

- **Fix multi-byte corruption in the SSE relay**: streamed responses containing non-ASCII text — accented characters, CJK, emoji — were corrupted whenever a TCP chunk boundary fell inside a character. SSE *lines* were already buffered across chunks, but the Node stream paths decoded each chunk with `chunk.toString()`, so both halves of a split character became U+FFFD. Both relays now decode with `StringDecoder`, and the web-stream paths flush the decoder at end of stream.
- **postinstall is guidance-only** — never mutates MCP/agent configs; run `supercompress setup` or `plugin`
- `prepack` / `npm run sync:assets` copies compress-engine + model from canonical `web/assets/`

## [0.5.23] — 2026-08-15

- **`plugin` persists `configured_agents`** so `account` / `status` show MCP installs on this machine.
- **`account` status**: no more false “not linked yet” when MCP/hooks are installed locally; API `me` treats API-key auth as linked.

## [0.5.22] — 2026-08-15

- **TUI theme**: follow terminal dark/light (macOS appearance / `COLORFGBG`; override with `SUPERCOMPRESS_THEME=dark|light`) — no more forced paper-light UI in dark terminals.
- **`supercompress account`**: call `/api/account?op=me` for API-key auth (plain `/api/me` is Firebase dashboard session only).

## [0.5.21] — 2026-08-14

- Idempotency keys are ≤40 chars (Auth claims watermarks truncate at 40; longer `sc_…` keys caused billing 503s for MCP/hooks).

## [0.5.20] — 2026-08-14

- **Accept Auth-backed API keys** (`sc_live_sck_…`): compressor `isValidApiKey` no longer rejects real linked keys (was treating `_` in the secret as invalid → “API key not found” / zero-looking usage until re-setup).
- Hosted compress retries on transient **503/429/timeout** with the same Idempotency-Key (billing-safe).
- Tests: unique MCP `session_id`s; concurrent MCP soft-retries on platform 503s.

## [0.5.19] — 2026-08-12

- **Interactive TUI** (`supercompress` / `supercompress tui`): paper-branded OpenTUI dashboard with live usage, account, connect, setup, plugin, agents, proxy, and MCP check. Needs [Bun](https://bun.sh); classic commands still work without it (`SUPERCOMPRESS_TUI=0` or `--plain`).
- Align CLI/MCP `usage` totals with the dashboard billing ledger (not coding-agent subset alone).
- Stable MCP launch after npm/brew upgrades: PATH `node` + package `mcp.js` (not Homebrew Cellar-pinned binaries); postinstall refreshes MCP paths without clearing auth.
- Docs: run `supercompress plugin` after upgrades to refresh integrations without reconnecting.
- Hook `Idempotency-Key` includes normalized **query** (avoids 409 when context reused for a new task).
- Partial chunk failure no longer marks session hashes seen; OpenClaw/Cursor feed full dumps into the chunker (1.2M soft cap, not 180k hard clip).
- OpenClaw skips inbox compress when no session/conversation id (no shared cwd fallback).
- **OpenClaw auto-compress parity with Hermes**: setup/plugin installs MCP + `AGENTS.md` + managed skill + internal hooks + extension plugin (tool dumps → inbox); uninstall cleans them.
- **Session-scoped inbox** (`inbox/<sessionId>/`) + `SUPERCOMPRESS_CONFIG_DIR` for OpenClaw plugin/hooks (no global `latest.md` cross-session leak).
- Exact OpenClaw plugin path match on install/uninstall (no substring deletes).
- `compactSessionMemory()` for OpenClaw compact:before; chunk dumps ≤120k; stable hook `Idempotency-Key`.
- **Preserve tool-call / tool-result order** when splitting compressible history (no reverse via `unshift`).
- Rank structured-history compression against the **latest user ask in the full thread**, not an older compressible-prefix turn.
- Send `Idempotency-Key` on compress API calls for safer retries with request-level billing idempotency.

## [0.5.18] — 2026-08-11

- **Keep auth across npm updates**: MCP entries use PATH `node` + this package's `mcp.js` (not Homebrew Cellar-pinned binaries). `postinstall` refreshes MCP paths when an account is already linked — never clears `~/.supercompress/config.json`.
- Docs: run `supercompress plugin` after upgrades to refresh integrations without reconnecting.

## [0.5.17] — 2026-08-10

- **Fix agent attribution**: Cursor postToolUse no longer mislabels usage as `claude_code` when the payload has `session_id`/`cwd` (Cursor always does).
- Cursor hooks now set `SUPERCOMPRESS_AGENT_NAME=Cursor` explicitly (same pattern as Claude Code / Codex).
- Stop using `configured_agents[0]` as the compress agent name (setup lists every detected agent).

## [0.5.16] — 2026-08-09

- **Hard paywall surfacing**: Cursor/Claude hooks + MCP no longer silently fail-open on HTTP 402.
- Inject loud `[SuperCompress PAYWALL]` upgrade CTA into agent context; proxy returns 402 (not 502) with billing URL.
- Restore missing `compressIncremental` export used by MCP `compress_context`.

## [0.5.15] — 2026-08-09

- **Setup-first**: `supercompress setup` / `plugin` is the recommended path (auto MCP + hooks). `wrap` deprecated.
- **Zed**: detect macOS Zed app; write MCP via `context_servers` (not Cursor `mcpServers`).
- Docs/links prefer `https://docs.supercompress.dev/...`.

## 0.5.14 — 2026-08-08

- **README rewrite**: wrap-first install (`supercompress wrap claude|codex|aider`). Removed monorepo / local-path install warnings. MCP documented as optional. Benchmarks linked.

## 0.5.13 — 2026-08-08

- Same README rewrite (initial publish).

## 0.5.12

- Harden device-link pairing codes to 128-bit entropy.

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
