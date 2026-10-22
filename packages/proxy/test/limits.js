#!/usr/bin/env node
/**
 * Runway (rate-limit) checks: normalizer, header capture, Codex telemetry,
 * planner decisions, store, CLI contract, MCP tool, proxy capture path.
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-limits-"));
process.env.SUPERCOMPRESS_CONFIG_DIR = path.join(tmp, "sc");
process.env.HOME = tmp;
process.env.CODEX_HOME = path.join(tmp, ".codex");
delete process.env.SUPERCOMPRESS_LIMITS_SNAPSHOT;
delete process.env.LIMITCHECK_SNAPSHOT;

const { normalizeSnapshot } = require("../src/limits/normalize");
const { windowsFromHeaders, snapshotFromResponse, parseDurationSeconds } = require("../src/limits/headers");
const { planRunway } = require("../src/limits/runway");
const sources = require("../src/limits/sources");
const store = require("../src/limits/store");
const limits = require("../src/limits");

let passed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

const NOW = new Date("2026-10-21T12:00:00.000Z");
const at = (min) => new Date(NOW.getTime() + min * 60000).toISOString();
function snap(windows, checkedAt = NOW.toISOString(), provider = "codex") {
  return normalizeSnapshot({ provider, checkedAt, windows });
}
const w5h = (used, resetMin, extra = {}) => ({ name: "5h", usedPercent: used, windowMinutes: 300, resetAt: at(resetMin), ...extra });
const wWeek = (used, resetMin) => ({ name: "weekly", usedPercent: used, windowMinutes: 10080, resetAt: at(resetMin) });

// ── normalizer ────────────────────────────────────────────────────────────
test("normalizes limitcheck codex shape (window_minutes, epoch resets)", () => {
  const s = normalizeSnapshot({
    provider: "codex",
    checkedAt: NOW.toISOString(),
    rate_limits: {
      primary: { used_percent: 38, window_minutes: 300, resets_at: 1792575222 },
      secondary: { used_percent: 19, window_minutes: 10080, resets_at: 1793089022 },
      credits: { has_credits: false },
    },
  });
  assert.deepStrictEqual(s.windows.map((w) => [w.name, w.kind, w.remainingPercent]), [["5h window", "short", 62], ["weekly", "long", 81]]);
  assert.strictEqual(s.windows[0].resetAt, "2026-10-21T09:33:42.000Z");
});

test("normalizes cursor used/limit and Claude statusline shapes", () => {
  const cursor = normalizeSnapshot({ provider: "cursor", usage: { monthly: { used: 560, limit: 1000 } } });
  assert.strictEqual(cursor.windows[0].name, "monthly");
  assert.strictEqual(cursor.windows[0].remainingPercent, 44);
  assert.strictEqual(cursor.windows[0].kind, "long");
  const claude = normalizeSnapshot({
    session_id: "x",
    rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1792600000 }, seven_day: { used_percentage: 41.2, resets_at: 1793000000 } },
  }, "claude");
  assert.strictEqual(claude.provider, "claude-code");
  assert.deepStrictEqual(claude.windows.map((w) => [w.name, w.usedPercent, w.windowMinutes]), [["5h window", 23.5, 300], ["weekly", 41.2, 10080]]);
});

test("Claude statusline: context_window is never mistaken for quota; spend_limit is long", () => {
  const apiKeyUser = { session_id: "s", transcript_path: "/t", context_window: { used_percentage: 97, remaining_percentage: 3 }, cost: { total_cost_usd: 1 } };
  assert.throws(() => normalizeSnapshot(apiKeyUser, "claude-code"), /No rate-limit windows/);
  assert.throws(() => limits.ingest(JSON.stringify(apiKeyUser)), /No rate-limit windows/);
  const gateway = normalizeSnapshot({
    session_id: "s",
    context_window: { used_percentage: 97 },
    rate_limits: { spend_limit: { used_percentage: 62.8, resets_at: 1740787200, used_usd: 314.12, limit_usd: 500, period: "monthly" } },
  });
  assert.deepStrictEqual(gateway.windows.map((w) => [w.name, w.kind, w.windowMinutes]), [["spend limit", "long", 43200]]);
});

test("keeps 0.1% precision near the cap (99.4% is not rounded to 99)", () => {
  const s = normalizeSnapshot({ windows: [{ name: "5h", usedPercent: 99.44 }] });
  assert.strictEqual(s.windows[0].remainingPercent, 0.6);
});

test("utilization fraction and harness aliases", () => {
  const s = normalizeSnapshot({ provider: "Roo Code", windows: [{ name: "5h", utilization: 0.42 }] });
  assert.strictEqual(s.provider, "roo-code");
  assert.strictEqual(s.windows[0].usedPercent, 42);
  for (const [alias, id] of [["grok", "grok-build"], ["gemini", "gemini-cli"], ["kilo", "kilo-code"], ["claude_code", "claude-code"], ["github-copilot", "copilot"]]) {
    assert.strictEqual(normalizeSnapshot({ provider: alias, windows: [{ name: "x", usedPercent: 1 }] }).provider, id);
  }
});

test("rejects payloads without windows", () => {
  assert.throws(() => normalizeSnapshot({ provider: "codex", rate_limits: { primary: null, secondary: null } }), /No rate-limit windows/);
});

// ── headers ───────────────────────────────────────────────────────────────
test("parses Anthropic unified subscription headers", () => {
  const ws = windowsFromHeaders({
    "anthropic-ratelimit-unified-5h-utilization": "0.91",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(NOW.getTime() / 1000) + 3600),
    "anthropic-ratelimit-unified-7d-utilization": "0.30",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor(NOW.getTime() / 1000) + 86400 * 3),
  }, NOW);
  const s = normalizeSnapshot({ provider: "anthropic", checkedAt: NOW.toISOString(), windows: ws });
  assert.deepStrictEqual(s.windows.map((w) => [w.name, w.usedPercent]), [["5h window", 91], ["weekly", 30]]);
  assert.strictEqual(s.windows[0].resetAt, at(60));
});

test("parses Anthropic API, OpenAI-compatible and Codex headers", () => {
  const anthropic = windowsFromHeaders(new Map([
    ["anthropic-ratelimit-tokens-limit", "400000"],
    ["anthropic-ratelimit-tokens-remaining", "100000"],
    ["anthropic-ratelimit-tokens-reset", at(1)],
  ]), NOW);
  assert.strictEqual(anthropic[0].remaining, 100000);
  const openai = normalizeSnapshot({ checkedAt: NOW.toISOString(), windows: windowsFromHeaders({
    "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": "499", "x-ratelimit-reset-requests": "6m0s",
    "x-ratelimit-limit-tokens": "30000", "x-ratelimit-remaining-tokens": "15000", "x-ratelimit-reset-tokens": "20ms",
  }, NOW) });
  assert.strictEqual(openai.windows[0].resetAt, at(6));
  assert.strictEqual(openai.windows[1].remainingPercent, 50);
  const codex = normalizeSnapshot({ checkedAt: NOW.toISOString(), windows: windowsFromHeaders({
    "x-codex-primary-used-percent": "73", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "1800",
  }, NOW) });
  assert.deepStrictEqual([codex.windows[0].name, codex.windows[0].resetAt], ["5h window", at(30)]);
  assert.strictEqual(parseDurationSeconds("1h2m3.5s"), 3723.5);
});

test("429 with retry-after marks the window exhausted", () => {
  const raw = snapshotFromResponse("openai", { status: 429, headers: { "retry-after": "90" } }, NOW);
  const s = normalizeSnapshot(raw);
  assert.strictEqual(s.windows[0].exhausted, true);
  const plan = planRunway(s, { now: NOW });
  assert.strictEqual(plan.action, "wait");
  assert.strictEqual(plan.waitMinutes, 2);
  assert.strictEqual(snapshotFromResponse("openai", { status: 200, headers: {} }, NOW), null);
});

// ── planner: the "max out the 5h window" contract ─────────────────────────
test("max policy keeps going at 92% of a 5h window (limitcheck would stop)", () => {
  const s = snap([w5h(92, 120), wWeek(30, 4000)]);
  const max = planRunway(s, { now: NOW });
  assert.strictEqual(max.action, "go");
  assert.strictEqual(max.proceed, true);
  const legacy = planRunway(s, { now: NOW, policy: "conservative" });
  assert.strictEqual(legacy.action, "wait", "conservative reproduces limitcheck's ≤10% stop");
});

test("max policy lands (checkpoint, keep working) in the last step of a window", () => {
  const plan = planRunway(snap([w5h(99.2, 40), wWeek(30, 4000)]), { now: NOW });
  assert.strictEqual(plan.action, "land");
  assert.strictEqual(plan.proceed, true);
  assert.strictEqual(plan.binding, "5h window");
  assert.ok(plan.guidance.some((g) => /do not stop early/i.test(g)));
});

test("only an exhausted window means wait, with time to reset", () => {
  const plan = planRunway(snap([w5h(100, 37), wWeek(30, 4000)]), { now: NOW });
  assert.strictEqual(plan.action, "wait");
  assert.strictEqual(plan.proceed, false);
  assert.strictEqual(plan.waitMinutes, 37);
});

test("stale snapshot whose window already reset rolls forward instead of blocking", () => {
  const old = new Date(NOW.getTime() - 6 * 3600000).toISOString();
  const s = normalizeSnapshot({ provider: "codex", checkedAt: old, windows: [{ name: "5h", usedPercent: 100, windowMinutes: 300, resetAt: at(-60) }] });
  const plan = planRunway(s, { now: NOW });
  assert.strictEqual(plan.action, "go");
  assert.strictEqual(plan.windows[0].remainingPercent, 100);
  assert.strictEqual(plan.windows[0].resetsInMinutes, 240);
  assert.strictEqual(plan.stale, true);
});

test("burn history: draining (runs out before reset) is still go; headroom says go bigger", () => {
  const points = [0, 10, 20, 30].map((m) => ({ t: at(m - 30), w: [{ n: "5h window", u: 50 + m, r: at(150) }] }));
  const draining = planRunway(snap([w5h(80, 150)]), { now: NOW, points });
  assert.strictEqual(draining.windows[0].burnPerHour, 60);
  assert.strictEqual(draining.windows[0].state, "draining");
  assert.strictEqual(draining.action, "go");
  const slow = [0, 30].map((m) => ({ t: at(m - 30), w: [{ n: "5h window", u: 10 + m / 10, r: at(200) }] }));
  const headroom = planRunway(snap([w5h(13, 200)]), { now: NOW, points: slow });
  assert.strictEqual(headroom.windows[0].state, "headroom");
  assert.strictEqual(headroom.scope, "large");
});

test("integer-percent ticks do not produce absurd burn rates", () => {
  const points = [{ t: at(-3), w: [{ n: "5h window", u: 40, r: at(200) }] }, { t: at(-1), w: [{ n: "5h window", u: 41, r: at(200) }] }];
  const plan = planRunway(snap([w5h(41, 200)]), { now: NOW, points });
  // 1% over 2 min would be 30%/h; we fall back to the window average (41% over 100 min).
  assert.strictEqual(plan.windows[0].burnSource, "window-average");
  assert.ok(plan.windows[0].burnPerHour < 30);
});

test("history segment stops at the previous reset", () => {
  const points = [
    { t: at(-200), w: [{ n: "5h window", u: 95, r: at(-100) }] },
    { t: at(-20), w: [{ n: "5h window", u: 2, r: at(200) }] },
    { t: at(-1), w: [{ n: "5h window", u: 8, r: at(200) }] },
  ];
  const plan = planRunway(snap([w5h(8, 200)]), { now: NOW, points });
  assert.ok(Math.abs(plan.windows[0].burnPerHour - 18.9) < 0.2, String(plan.windows[0].burnPerHour));
});

test("weekly ahead of pace: max warns, balanced paces", () => {
  // 70% of the week used with 4 days still to go.
  const s = snap([w5h(10, 200), wWeek(70, 4 * 1440)]);
  const max = planRunway(s, { now: NOW });
  assert.strictEqual(max.action, "go");
  assert.strictEqual(max.windows[1].state, "over-pace");
  assert.ok(max.guidance.some((g) => /ahead of pace/.test(g)));
  assert.strictEqual(planRunway(s, { now: NOW, policy: "balanced" }).action, "pace");
});

test("per-minute API buckets never trigger landing", () => {
  const s = snap([{ name: "tokens / min", limit: 1000, remaining: 5, used: 995, windowMinutes: 1, resetAt: at(1) }], NOW.toISOString(), "openai");
  assert.strictEqual(planRunway(s, { now: NOW }).action, "go");
});

// ── Codex telemetry ───────────────────────────────────────────────────────
function writeSession(name, mtimeMin, events) {
  const dir = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "21");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const t = new Date(NOW.getTime() + mtimeMin * 60000);
  fs.utimesSync(file, t, t);
}
const tokenCount = (ts, primary, secondary) => ({ timestamp: ts, type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary, secondary, credits: null } } });

test("Codex: skips credits-only sessions (primary null) and keeps history", () => {
  const reset = Math.floor(NOW.getTime() / 1000) + 7200;
  writeSession("old.jsonl", -30, [
    { timestamp: at(-40), type: "response_item", payload: { type: "message", content: "secret prompt text" } },
    tokenCount(at(-40), { used_percent: 60, window_minutes: 300, resets_at: reset }, { used_percent: 20, window_minutes: 10080, resets_at: reset + 86400 }),
    tokenCount(at(-30), { used_percent: 70, window_minutes: 300, resets_at: reset }, { used_percent: 21, window_minutes: 10080, resets_at: reset + 86400 }),
  ]);
  for (let i = 0; i < 14; i += 1) writeSession(`new-${i}.jsonl`, -5 + i / 10, [tokenCount(at(-5), null, null)]);
  const codex = sources.readCodex();
  assert.ok(codex, "found populated event behind 14 credits-only sessions");
  assert.strictEqual(codex.snapshot.windows[0].usedPercent, 70);
  assert.strictEqual(codex.points.length, 2);
  assert.ok(!JSON.stringify(codex).includes("secret prompt"));
  const result = limits.status({ provider: "codex", now: NOW });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.windows[0].burnPerHour, 60);
});

// ── store + ingest ────────────────────────────────────────────────────────
test("store: older snapshots never overwrite newer; history dedups", () => {
  const newer = store.recordSnapshot({ provider: "cursor", checkedAt: at(0), windows: [{ name: "monthly", usedPercent: 50 }] });
  store.recordSnapshot({ provider: "cursor", checkedAt: at(-10), windows: [{ name: "monthly", usedPercent: 10 }] });
  assert.strictEqual(store.readSnapshot("cursor").windows[0].usedPercent, newer.windows[0].usedPercent);
  store.recordSnapshot({ provider: "cursor", checkedAt: at(0.5), windows: [{ name: "monthly", usedPercent: 50 }] });
  assert.strictEqual(store.readHistory("cursor").length, 1);
});

test("ingest detects Claude statusline payloads", () => {
  const s = limits.ingest(JSON.stringify({ checkedAt: at(-1), session_id: "abc", model: { id: "x" }, rate_limits: { five_hour: { used_percentage: 12, resets_at: Math.floor(NOW.getTime() / 1000) + 3600 } } }));
  assert.strictEqual(s.provider, "claude-code");
  const r = limits.status({ provider: "claude-code", now: NOW, env: {} });
  assert.strictEqual(r.provider, "claude-code");
  assert.strictEqual(r.windows[0].remainingPercent, 88);
});

test("status prefers the running harness and lists alternatives on wait", () => {
  store.recordSnapshot({ provider: "claude-code", checkedAt: at(0), windows: [w5h(100, 30)] });
  const r = limits.status({ now: NOW, env: { CLAUDECODE: "1" } });
  assert.strictEqual(r.harness, "claude-code");
  assert.strictEqual(r.action, "wait");
  assert.ok(r.alternatives.some((a) => a.provider === "codex"));
});

test("never answers one harness with another's quota", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-limits-harness-"));
  const prev = process.env.SUPERCOMPRESS_CONFIG_DIR;
  const prevCodex = process.env.CODEX_HOME;
  process.env.SUPERCOMPRESS_CONFIG_DIR = path.join(home, "sc");
  process.env.CODEX_HOME = path.join(home, ".codex");
  try {
    store.recordSnapshot({ provider: "codex", checkedAt: at(0), windows: [w5h(10, 200)] });
    const inClaude = limits.status({ now: NOW, env: { CLAUDECODE: "1" } });
    assert.strictEqual(inClaude.available, false);
    assert.strictEqual(inClaude.provider, "claude-code");
    assert.strictEqual(inClaude.action, "unknown");
    assert.deepStrictEqual(inClaude.alternatives.map((a) => a.provider), ["codex"]);
    assert.match(limits.formatText(inClaude), /codex: go/);
    // Claude Code with an API key through the local proxy → anthropic headers answer.
    store.recordSnapshot({ provider: "anthropic", checkedAt: at(0), windows: [w5h(95, 60)] });
    const viaProxy = limits.status({ now: NOW, env: { CLAUDECODE: "1" } });
    assert.strictEqual(viaProxy.provider, "anthropic");
    assert.strictEqual(viaProxy.action, "go");
    // No harness detected → newest reading.
    assert.ok(limits.status({ now: NOW, env: {} }).available);
  } finally {
    process.env.SUPERCOMPRESS_CONFIG_DIR = prev;
    process.env.CODEX_HOME = prevCodex;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("unknown when no source exists, never invented", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sc-limits-empty-"));
  const res = spawnSync(process.execPath, [path.join(ROOT, "bin/supercompress.js"), "limits", "--json", "--provider", "windsurf"], {
    env: { ...process.env, HOME: empty, SUPERCOMPRESS_CONFIG_DIR: path.join(empty, "sc"), CODEX_HOME: path.join(empty, ".codex") },
    encoding: "utf8",
  });
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.available, false);
  assert.strictEqual(out.action, "unknown");
  assert.ok(!("windows" in out));
});

// ── CLI contract ──────────────────────────────────────────────────────────
function cli(args, input, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, "bin/supercompress.js"), ...args], {
    env: { ...process.env, ...extraEnv }, input, encoding: "utf8",
  });
}

test("CLI: `limits --json` prints exactly one JSON line, no logo", () => {
  const payload = JSON.stringify({ provider: "codex", windows: [{ name: "5h", usedPercent: 91, windowMinutes: 300 }] });
  const res = cli(["limits", "--json", "--json-input", payload]);
  assert.strictEqual(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split("\n");
  assert.strictEqual(lines.length, 1);
  const out = JSON.parse(lines[0]);
  assert.strictEqual(out.version, 2);
  assert.strictEqual(out.action, "go");
  const legacy = cli(["limits", "--json", "--policy", "conservative"], undefined, { LIMITCHECK_SNAPSHOT: payload });
  assert.strictEqual(JSON.parse(legacy.stdout).action, "wait");
});

test("CLI: bad input exits 2 on stderr", () => {
  const res = cli(["limits", "--json", "--json-input", "{\"provider\":\"x\"}"]);
  assert.strictEqual(res.status, 2);
  assert.strictEqual(res.stdout, "");
  assert.match(res.stderr, /No rate-limit windows/);
  const bad = cli(["limits", "--json", "--policy", "yolo", "--json-input", "{\"windows\":[{\"name\":\"a\",\"usedPercent\":1}]}"]);
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /Unknown policy/);
});

test("CLI: ingest --passthrough tees stdin unchanged, even on junk", () => {
  const statusJson = JSON.stringify({ session_id: "s", rate_limits: { five_hour: { used_percentage: 40, resets_at: 1893456000 } } });
  const res = cli(["limits", "ingest", "--provider", "claude-code", "--passthrough"], statusJson);
  assert.strictEqual(res.stdout, statusJson);
  const junk = cli(["limits", "ingest", "--passthrough"], "not json");
  assert.strictEqual(junk.status, 0);
  assert.strictEqual(junk.stdout, "not json");
  const line = cli(["limits", "statusline"], statusJson);
  assert.match(line.stdout, /^runway 5h 60%/);
});

test("CLI: connect/disconnect wraps and restores the Claude statusline", () => {
  const claudeDir = path.join(tmp, "claude-cfg");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settings = path.join(claudeDir, "settings.json");
  const original = { type: "command", command: "node /x/status.mjs", padding: 0 };
  fs.writeFileSync(settings, JSON.stringify({ theme: "dark", statusLine: original }));
  const env = { CLAUDE_CONFIG_DIR: claudeDir };
  assert.strictEqual(cli(["limits", "connect", "claude-code"], undefined, env).status, 0);
  const wrapped = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.match(wrapped.statusLine.command, /^\(SUPERCOMPRESS_CONFIG_DIR='[^']+' .*runway\/run\.js' ingest --provider claude-code --passthrough 2>\/dev\/null \|\| cat\) \| \( node \/x\/status\.mjs\n\)$/);
  assert.strictEqual(wrapped.theme, "dark");
  assert.ok(fs.existsSync(path.join(process.env.SUPERCOMPRESS_CONFIG_DIR, "runway", "run.js")), "runtime copied out of the package");
  cli(["limits", "connect", "claude-code"], undefined, env); // idempotent
  assert.strictEqual(JSON.parse(fs.readFileSync(settings, "utf8")).statusLine.command, wrapped.statusLine.command);
  cli(["limits", "disconnect", "claude-code"], undefined, env);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { theme: "dark", statusLine: original });
  // No prior statusline → ours is added, then removed cleanly.
  fs.writeFileSync(settings, JSON.stringify({ theme: "dark" }));
  cli(["limits", "connect"], undefined, env);
  assert.match(JSON.parse(fs.readFileSync(settings, "utf8")).statusLine.command, /run\.js' statusline 2>\/dev\/null \|\| true$/);
  cli(["limits", "disconnect"], undefined, env);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { theme: "dark" });
});

test("statusline tee runs through a real shell and survives a missing runtime", () => {
  const claudeDir = path.join(tmp, "claude-shell");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settings = path.join(claudeDir, "settings.json");
  const sink = path.join(tmp, "statusline-sink.txt");
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: `cat > ${JSON.stringify(sink)}; echo user-line` } }));
  cli(["limits", "connect"], undefined, { CLAUDE_CONFIG_DIR: claudeDir });
  const command = JSON.parse(fs.readFileSync(settings, "utf8")).statusLine.command;
  const payload = JSON.stringify({ session_id: "sh", rate_limits: { five_hour: { used_percentage: 64, resets_at: Math.floor(Date.now() / 1000) + 3600 } } });
  const res = spawnSync("/bin/sh", ["-c", command], { input: payload, encoding: "utf8", env: process.env });
  assert.strictEqual(res.stdout.trim(), "user-line", "user's statusline output is untouched");
  assert.strictEqual(fs.readFileSync(sink, "utf8"), payload, "user's statusline still receives the full JSON");
  assert.strictEqual(store.readSnapshot("claude-code").windows[0].usedPercent, 64, "tee recorded the limits");
  // Runtime deleted (e.g. config wiped) → `|| cat` keeps the statusline alive.
  fs.rmSync(path.join(process.env.SUPERCOMPRESS_CONFIG_DIR, "runway"), { recursive: true, force: true });
  fs.rmSync(sink);
  const broken = spawnSync("/bin/sh", ["-c", command], { input: payload, encoding: "utf8", env: process.env });
  assert.strictEqual(broken.stdout.trim(), "user-line");
  assert.strictEqual(fs.readFileSync(sink, "utf8"), payload);
  cli(["limits", "disconnect"], undefined, { CLAUDE_CONFIG_DIR: claudeDir });
});

test("setup (installAutoPlugin) wires runway and uninstall removes it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-limits-setup-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const userLine = { type: "command", command: "node ~/my-statusline.js", padding: 1 };
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", statusLine: userLine }, null, 2));
  const env = { HOME: home, USERPROFILE: home, SUPERCOMPRESS_CONFIG_DIR: path.join(home, ".supercompress"), CLAUDE_CONFIG_DIR: "" };
  const plugin = cli(["plugin"], undefined, env);
  assert.strictEqual(plugin.status, 0, plugin.stderr);
  assert.match(plugin.stdout, /Runway \(limits\)/);
  const after = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.match(after.statusLine.command, /ingest --provider claude-code --passthrough 2>\/dev\/null \|\| cat\) \| \( node ~\/my-statusline\.js\n\)$/);
  assert.ok(after.hooks, "existing SuperCompress hooks still installed alongside");
  assert.ok(fs.existsSync(path.join(home, ".supercompress", "runway", "run.js")));
  const instructions = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
  assert.match(instructions, /runway_check/);
  const un = cli(["uninstall"], undefined, env);
  assert.strictEqual(un.status, 0, un.stderr);
  const restored = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.deepStrictEqual(restored.statusLine, userLine);
  assert.strictEqual(restored.theme, "dark");
  assert.ok(!JSON.stringify(restored).includes("runway"));
  fs.rmSync(home, { recursive: true, force: true });
});

test("SUPERCOMPRESS_RUNWAY=0 setup leaves the statusline alone", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-limits-off-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const env = { HOME: home, USERPROFILE: home, SUPERCOMPRESS_CONFIG_DIR: path.join(home, ".supercompress"), CLAUDE_CONFIG_DIR: "", SUPERCOMPRESS_RUNWAY: "0" };
  assert.strictEqual(cli(["plugin"], undefined, env).status, 0);
  const s = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.ok(!s.statusLine);
  fs.rmSync(home, { recursive: true, force: true });
});

test("compound statuslines stay whole; custom config dir is pinned", () => {
  const claudeDir = path.join(tmp, "claude-compound");
  const workDir = path.join(tmp, "status-work");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const settings = path.join(claudeDir, "settings.json");
  const original = `cd ${JSON.stringify(workDir)} && cat > sink.json && echo compound-ok`;
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: original } }));
  const customDir = path.join(tmp, "custom-sc");
  cli(["limits", "connect"], undefined, { CLAUDE_CONFIG_DIR: claudeDir, SUPERCOMPRESS_CONFIG_DIR: customDir });
  const command = JSON.parse(fs.readFileSync(settings, "utf8")).statusLine.command;
  const payload = JSON.stringify({ session_id: "c", rate_limits: { five_hour: { used_percentage: 33, resets_at: Math.floor(Date.now() / 1000) + 3600 } } });
  // Run with NO config-dir env: the pinned dir must still be used.
  const env = { ...process.env };
  delete env.SUPERCOMPRESS_CONFIG_DIR;
  const res = spawnSync("/bin/sh", ["-c", command], { input: payload, encoding: "utf8", env });
  assert.strictEqual(res.stdout.trim(), "compound-ok");
  assert.strictEqual(fs.readFileSync(path.join(workDir, "sink.json"), "utf8"), payload, "every part of a compound statusline gets stdin");
  assert.ok(fs.existsSync(path.join(customDir, "limits", "snapshots", "claude-code.json")), "wrote the pinned config dir");
  cli(["limits", "disconnect"], undefined, { CLAUDE_CONFIG_DIR: claudeDir, SUPERCOMPRESS_CONFIG_DIR: customDir });
  assert.strictEqual(JSON.parse(fs.readFileSync(settings, "utf8")).statusLine.command, original);
});

test("harness detection ignores storage settings like CODEX_HOME", () => {
  assert.strictEqual(sources.detectHarness({ CODEX_HOME: "/x", CURSOR_AGENT: "1" }), "cursor");
  assert.strictEqual(sources.detectHarness({ CODEX_HOME: "/x" }), null);
  assert.strictEqual(sources.detectHarness({ SUPERCOMPRESS_AGENT_NAME: "Claude Code", CURSOR_AGENT: "1" }), "claude-code");
  assert.strictEqual(sources.detectHarness({ CODEX_THREAD_ID: "t" }), "codex");
});

test("429 never reopens before retry-after", () => {
  const raw = snapshotFromResponse("openai", { status: 429, headers: {
    "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "60s", "retry-after": "120",
  } }, NOW);
  const plan = planRunway(normalizeSnapshot(raw), { now: NOW });
  assert.strictEqual(plan.action, "wait");
  assert.strictEqual(plan.waitMinutes, 2);
});

test("separate API keys keep separate readings and history", () => {
  const ok = { status: 200, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "90" } };
  const low = { status: 200, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "5" } };
  const a = limits.capture("openrouter", ok, { apiKey: "key-a" });
  const b = limits.capture("openrouter", low, { apiKey: "key-b" });
  assert.ok(a.account && b.account && a.account !== b.account);
  assert.strictEqual(store.readSnapshot("openrouter", a.account).windows[0].remainingPercent, 90);
  assert.strictEqual(store.readSnapshot("openrouter", b.account).windows[0].remainingPercent, 5);
  assert.strictEqual(store.readHistory("openrouter", a.account).length, 1);
});

test("ingest without a payload fails clearly", () => {
  const res = cli(["limits", "ingest"], "");
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /No usage JSON on stdin/);
});

test("every shipped skill has valid, quoted frontmatter", () => {
  for (const rel of [
    "agent-plugin/skills/supercompress/SKILL.md",
    "src/grok-hooks/skills/supercompress/SKILL.md",
    "src/openclaw-hooks/skills/supercompress/SKILL.md",
    "../../integrations/plugins/supercompress/skills/supercompress/SKILL.md",
  ]) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const desc = text.match(/^description: (.*)$/m)[1];
    assert.ok(desc.startsWith('"') && desc.endsWith('"'), `${rel}: description must be quoted`);
    assert.ok(JSON.parse(desc).length > 40, rel);
  }
});

// ── MCP + proxy capture ───────────────────────────────────────────────────
test("MCP: runway_check is listed and answers locally", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "src/mcp.js")], { env: process.env, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const complete = () => buf.split("\n").slice(0, -1).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mcp timeout: " + buf)), 10000);
      child.stdout.on("data", (d) => {
        buf += d;
        const ids = complete().map((m) => m.id);
        if (ids.includes(1) && ids.includes(2)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "runway_check", arguments: { provider: "codex" } } }) + "\n");
    });
  } finally {
    child.kill();
  }
  const msgs = complete();
  assert.ok(msgs.find((m) => m.id === 1).result.tools.some((t) => t.name === "runway_check"));
  const body = JSON.parse(msgs.find((m) => m.id === 2).result.content[0].text);
  assert.strictEqual(body.provider, "codex");
  assert.ok(!("providers" in body), "compact payload for agents");
});

test("proxy forwarder records upstream rate-limit headers", async () => {
  const reset = new Date(Date.now() + 3600000).toISOString();
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "anthropic-ratelimit-tokens-limit": "1000",
        "anthropic-ratelimit-tokens-remaining": "250",
        "anthropic-ratelimit-tokens-reset": reset,
        "anthropic-ratelimit-unified-5h-utilization": "0.97",
        "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 1800),
      });
      res.end(JSON.stringify({ id: "m", content: [{ type: "text", text: "ok" }], model: "x", stop_reason: "end_turn", usage: {} }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const port = upstream.address().port;
  const script = `
    const fw = require(${JSON.stringify(path.join(ROOT, "src/forwarder.js"))});
    const res = { json() {}, setHeader() {}, write() {}, end() {} };
    fw.forwardAnthropic("claude-x", { messages: [{ role: "user", content: "hi" }] }, "", {}, res, null, "sk-test", {})
      .then(() => {
        const store = require(${JSON.stringify(path.join(ROOT, "src/limits/store.js"))});
        const acct = require("crypto").createHash("sha256").update("sk-test").digest("hex").slice(0, 10);
        process.stdout.write(JSON.stringify(store.readSnapshot("anthropic", acct)));
      })
      .catch((e) => { console.error(e); process.exit(1); });
  `;
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, SUPERCOMPRESS_ANTHROPIC_BASE: `http://127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => child.on("close", r));
  upstream.close();
  assert.strictEqual(code, 0, err);
  const s = JSON.parse(out);
  assert.strictEqual(s.provider, "anthropic");
  assert.strictEqual(s.source, "proxy-headers");
  assert.ok(s.account && !out.includes("sk-test"), "fingerprint only, never the key");
  const five = s.windows.find((w) => w.name === "5h window");
  assert.strictEqual(five.usedPercent, 97);
  const plan = planRunway(s, { now: new Date() });
  assert.strictEqual(plan.action, "go", "97% of a 5h window is still go under max");
});

test("SUPERCOMPRESS_RUNWAY=0 disables proxy capture", () => {
  process.env.SUPERCOMPRESS_RUNWAY = "0";
  assert.strictEqual(limits.capture("xai", { status: 200, headers: { "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "1" } }), null);
  delete process.env.SUPERCOMPRESS_RUNWAY;
  assert.ok(limits.capture("xai", { status: 200, headers: { "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "1" } }));
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}\n    ${err.stack || err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\nlimits: ${passed}/${tests.length} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
})();
