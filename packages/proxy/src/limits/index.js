/**
 * Runway — rate-limit awareness for every harness SuperCompress plugs into.
 *
 * Entry points:
 *   status()   one agent-facing answer (CLI `supercompress limits`, MCP `runway_check`)
 *   ingest()   accept a usage payload from a harness (Claude Code statusline, hooks)
 *   capture()  record upstream rate-limit headers seen by the local proxy
 */

const { createHash } = require("crypto");
const { normalizeProvider, normalizeSnapshot } = require("./normalize");
const { snapshotFromResponse } = require("./headers");
const { planRunway, fmtDuration } = require("./runway");
const sources = require("./sources");
const store = require("./store");

const SCHEMA_VERSION = 2;

/** Harness → providers that carry its quota (its own telemetry, then its API via the local proxy). */
const HARNESS_UPSTREAM = {
  "claude-code": ["claude-code", "anthropic"],
  codex: ["codex", "openai"],
  "grok-build": ["grok-build", "xai"],
};

function disabled() {
  const v = String(process.env.SUPERCOMPRESS_RUNWAY || "").trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no";
}

/**
 * @param {object} [opts]
 * @param {string} [opts.provider]  restrict to one provider/harness
 * @param {string|object} [opts.raw] explicit usage payload
 * @param {string} [opts.policy]    max | balanced | conservative
 * @param {Date}   [opts.now]
 */
function status(opts = {}) {
  const now = opts.now ?? new Date();
  const policy = opts.policy || process.env.SUPERCOMPRESS_RUNWAY_POLICY || "max";
  const entries = sources.collect({ raw: opts.raw, provider: opts.provider, sessionsRoot: opts.sessionsRoot });
  const harness = sources.detectHarness(opts.env ?? process.env);

  const providers = entries.map(({ snapshot, points }) => ({
    provider: snapshot.provider,
    checkedAt: snapshot.checkedAt,
    source: snapshot.source ?? "cache",
    runway: planRunway(snapshot, { points, now, policy }),
  }));

  // Which provider answers for this agent: an explicit payload, else the
  // requested provider, else the harness we are running in (or the API it
  // reaches through the local proxy), else the newest reading. Never answer a
  // Claude Code agent with Codex's quota.
  const requested = opts.provider && normalizeProvider(opts.provider) !== "generic" ? normalizeProvider(opts.provider) : null;
  let primary;
  if (providers.length === 1 && providers[0].source === "explicit") primary = providers[0];
  else if (requested) primary = providers.find((p) => p.provider === requested);
  else if (harness) primary = (HARNESS_UPSTREAM[harness] ?? [harness]).map((id) => providers.find((p) => p.provider === id)).find(Boolean);
  else primary = providers[0];

  if (!primary) {
    const others = providers
      .filter((p) => p.runway.proceed && !p.runway.stale)
      .map((p) => ({ provider: p.provider, action: p.runway.action, binding: p.runway.binding }));
    return {
      version: SCHEMA_VERSION,
      available: false,
      checkedAt: new Date(now).toISOString(),
      ...(harness ? { harness } : {}),
      ...(requested || harness ? { provider: requested ?? harness } : {}),
      action: "unknown",
      proceed: true,
      summary: `unknown · no usage data for ${requested ?? harness ?? "this agent"} yet — carry on and never guess a limit`,
      hint: hintFor(requested ?? harness),
      ...(others.length ? { alternatives: others } : {}),
      providers,
    };
  }

  const alternatives = providers
    .filter((p) => p !== primary && p.runway.proceed && !p.runway.stale)
    .map((p) => ({ provider: p.provider, action: p.runway.action, binding: p.runway.binding }));

  const r = primary.runway;
  return {
    version: SCHEMA_VERSION,
    available: true,
    checkedAt: new Date(now).toISOString(),
    ...(harness ? { harness } : {}),
    provider: primary.provider,
    action: r.action,
    proceed: r.proceed,
    scope: r.scope,
    policy: r.policy,
    binding: r.binding,
    ...(r.waitMinutes !== undefined ? { waitMinutes: r.waitMinutes } : {}),
    summary: `${primary.provider} ${r.summary}`,
    guidance: r.guidance,
    windows: r.windows,
    stale: r.stale,
    ...(alternatives.length ? { alternatives } : {}),
    providers,
  };
}

function hintFor(provider) {
  switch (provider) {
    case "claude-code":
      return "Claude Code reports limits through its statusline after the first reply. `supercompress setup` wires this; if you skipped it, run `supercompress limits connect claude-code` once.";
    case "codex":
      return "Codex logs rate limits after its first model turn in a session; run again after one turn.";
    case "cursor":
    case "windsurf":
      return "No local quota telemetry. Pipe usage JSON to `supercompress limits ingest --provider " + provider + "` from a hook.";
    default:
      return "Route the harness through the SuperCompress proxy (captures provider rate-limit headers), or pipe usage JSON to `supercompress limits ingest`.";
  }
}

/** Accept any supported payload shape from a harness. */
function ingest(raw, providerHint) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  // Claude Code statusline JSON: { model, session_id, rate_limits: { five_hour, seven_day } }.
  const hint = providerHint ?? (parsed && (parsed.session_id || parsed.transcript_path) ? "claude-code" : undefined);
  const snapshot = store.recordSnapshot({ source: "ingest", ...parsed }, hint ?? "generic");
  if (!snapshot) throw new TypeError("No rate-limit windows found in payload.");
  return snapshot;
}

const CAPTURE_MIN_INTERVAL_MS = 2000;
const lastCapture = new Map();

/**
 * Record headers from an upstream provider response. Never throws.
 * `apiKey` only feeds a one-way fingerprint so separate accounts keep
 * separate readings; the key itself is never stored.
 */
function capture(provider, response, { apiKey } = {}) {
  if (disabled()) return null;
  try {
    // Hot path: at most one disk write per provider every 2s, except 429s.
    const nowMs = Date.now();
    const account = apiKey ? createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 10) : undefined;
    const throttleKey = `${provider}:${account ?? ""}`;
    if (response?.status !== 429 && nowMs - (lastCapture.get(throttleKey) ?? 0) < CAPTURE_MIN_INTERVAL_MS) return null;
    const raw = snapshotFromResponse(provider, response);
    if (raw) lastCapture.set(throttleKey, nowMs);
    return raw ? store.recordSnapshot(raw, provider, { account }) : null;
  } catch {
    return null;
  }
}

function bar(remaining, width = 10) {
  const filled = Math.round((Math.max(0, Math.min(100, remaining)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatText(result) {
  if (!result.available) {
    const lines = [`runway · ${result.summary}`, `  ${result.hint}`];
    for (const p of result.providers ?? []) lines.push(`  · ${p.provider}: ${p.runway.summary}${p.runway.stale ? " (stale)" : ""}`);
    return lines.join("\n");
  }
  const lines = [`runway · ${result.provider} · ${result.action.toUpperCase()}${result.scope && result.scope !== "none" ? ` (scope: ${result.scope})` : ""}`];
  for (const w of result.windows) {
    const reset = w.resetsInMinutes !== undefined ? `resets in ${fmtDuration(w.resetsInMinutes)}` : "reset unknown";
    const burn = w.burnPerHour !== undefined ? ` · ${w.burnPerHour}%/h` : "";
    lines.push(`  ${w.name.padEnd(16)} ${bar(w.remainingPercent)} ${String(w.remainingPercent).padStart(5)}% left · ${reset}${burn} · ${w.state}`);
  }
  for (const g of result.guidance) lines.push(`  → ${g}`);
  if (result.alternatives?.length) {
    lines.push(`  alternatives: ${result.alternatives.map((a) => `${a.provider} (${a.action})`).join(", ")}`);
  }
  const others = result.providers.filter((p) => p.provider !== result.provider);
  for (const p of others) lines.push(`  · ${p.provider}: ${p.runway.summary}${p.runway.stale ? " (stale)" : ""}`);
  return lines.join("\n");
}

module.exports = { status, ingest, capture, formatText, normalizeSnapshot, planRunway, SCHEMA_VERSION, disabled };
