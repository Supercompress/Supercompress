/**
 * Normalize provider usage payloads into one window shape.
 *
 * Ported from limitcheck (github.com/arjunkshah12345-hash/limitcheck) and
 * extended: more harness aliases, window length inference (5h / weekly /
 * monthly / per-minute API limits), and 0.1% precision so a window at 99.4%
 * used is not rounded into "99% → stop early".
 */

const PROVIDER_ALIASES = new Map([
  ["claude", "claude-code"],
  ["claude_code", "claude-code"],
  ["claudecode", "claude-code"],
  ["codex", "codex"],
  ["codex-cli", "codex"],
  ["cursor", "cursor"],
  ["cursor-agent", "cursor"],
  ["opencode", "opencode"],
  ["open-code", "opencode"],
  ["windsurf", "windsurf"],
  ["cline", "cline"],
  ["roo", "roo-code"],
  ["roo-code", "roo-code"],
  ["roocode", "roo-code"],
  ["continue", "continue"],
  ["aider", "aider"],
  ["zed", "zed"],
  ["goose", "goose"],
  ["hermes", "hermes"],
  ["openclaw", "openclaw"],
  ["grok", "grok-build"],
  ["grok-build", "grok-build"],
  ["grok-cli", "grok-build"],
  ["fx", "fx"],
  ["gemini", "gemini-cli"],
  ["gemini-cli", "gemini-cli"],
  ["copilot", "copilot"],
  ["copilot-cli", "copilot"],
  ["github-copilot", "copilot"],
  ["kiro", "kiro"],
  ["amazon-q", "amazon-q"],
  ["q", "amazon-q"],
  ["openhands", "openhands"],
  ["kilo", "kilo-code"],
  ["kilo-code", "kilo-code"],
  ["croc", "croc"],
  ["croc-bot", "croc"],
  ["crocbot", "croc"],
  // Raw API providers seen by the local proxy.
  ["anthropic", "anthropic"],
  ["anthropic-api", "anthropic"],
  ["openai", "openai"],
  ["openai-api", "openai"],
  ["xai", "xai"],
  ["openrouter", "openrouter"],
]);

const KNOWN_WINDOWS = new Map([
  ["fivehour", ["5h window", 300]],
  ["5h", ["5h window", 300]],
  ["5hwindow", ["5h window", 300]],
  ["primary", ["primary window", null]],
  ["primarywindow", ["primary window", null]],
  ["weekly", ["weekly", 10080]],
  ["week", ["weekly", 10080]],
  ["sevenday", ["weekly", 10080]],
  ["7d", ["weekly", 10080]],
  ["sevendayopus", ["weekly (opus)", 10080]],
  ["sevendaysonnet", ["weekly (sonnet)", 10080]],
  ["secondary", ["secondary window", null]],
  ["secondarywindow", ["secondary window", null]],
  ["monthly", ["monthly", 43200]],
  ["month", ["monthly", 43200]],
  ["daily", ["daily", 1440]],
  ["spendlimit", ["spend limit", null]],
  ["day", ["daily", 1440]],
]);

const PERIOD_MINUTES = { daily: 1440, day: 1440, weekly: 10080, week: 10080, monthly: 43200, month: 43200 };

/** Windows shorter than this are "use it or lose it" and are drained to 100%. */
const SHORT_WINDOW_MAX_MINUTES = 24 * 60;

function normalizeProvider(value = "generic") {
  const key = String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return PROVIDER_ALIASES.get(key) ?? (key || "generic");
}

function numberFrom(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value.replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function isWindowLike(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [
    "usedPercent", "used_percent", "used_percentage", "utilization",
    "remainingPercent", "remaining_percent", "remaining_percentage",
    "used", "remaining", "limit",
  ].some((key) => key in value && value[key] !== null && value[key] !== undefined);
}

function knownWindow(name) {
  const key = String(name).toLowerCase().replace(/[\s_-]/g, "");
  return KNOWN_WINDOWS.get(key) ?? null;
}

function inferWindowMinutes(name, raw) {
  const explicit = numberFrom(raw?.windowMinutes ?? raw?.window_minutes);
  if (explicit && explicit > 0) return explicit;
  const seconds = numberFrom(raw?.windowSeconds ?? raw?.window_seconds);
  if (seconds && seconds > 0) return seconds / 60;
  const period = String(raw?.period ?? "").toLowerCase();
  if (PERIOD_MINUTES[period]) return PERIOD_MINUTES[period];
  return knownWindow(name)?.[1] ?? null;
}

function displayName(name, raw, windowMinutes) {
  if (raw?.label) return String(raw.label);
  if (knownWindow(name)?.[0] === "spend limit") return "spend limit";
  if (windowMinutes === 300) return "5h window";
  if (windowMinutes === 10080) return knownWindow(name)?.[0]?.startsWith("weekly") ? knownWindow(name)[0] : "weekly";
  if (windowMinutes && windowMinutes >= 40320 && windowMinutes <= 44640) return "monthly";
  if (windowMinutes === 1440) return "daily";
  return knownWindow(name)?.[0] ?? String(name).replace(/[_-]/g, " ");
}

function normalizeReset(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function resetFrom(raw, checkedAt) {
  const absolute = normalizeReset(raw.resetAt ?? raw.resetsAt ?? raw.resets_at ?? raw.reset_at);
  if (absolute) return absolute;
  const after = numberFrom(raw.resetAfterSeconds ?? raw.reset_after_seconds ?? raw.resetsInSeconds ?? raw.resets_in_seconds);
  if (after === null) return null;
  const base = new Date(checkedAt ?? Date.now()).getTime();
  return Number.isFinite(base) ? new Date(base + after * 1000).toISOString() : null;
}

function normalizeWindow(name, raw, checkedAt) {
  let usedPercent = numberFrom(raw.usedPercent ?? raw.used_percentage ?? raw.used_percent);
  // Anthropic `utilization` is a 0..1 fraction in headers and 0..100 in the
  // OAuth usage API. Treat anything <= 1 as a fraction.
  const utilization = numberFrom(raw.utilization);
  if (usedPercent === null && utilization !== null) {
    usedPercent = utilization <= 1 ? utilization * 100 : utilization;
  }
  const remainingPercent = numberFrom(raw.remainingPercent ?? raw.remaining_percentage ?? raw.remaining_percent);
  const rawLimit = numberFrom(raw.limit ?? raw.total ?? raw.max);
  const rawUsed = numberFrom(raw.used);
  const rawRemaining = numberFrom(raw.remaining);

  let used = usedPercent;
  let remaining = remainingPercent;
  let limit = rawLimit;
  const unit = raw.unit ?? (usedPercent !== null || remainingPercent !== null ? "percent" : "units");

  if (used === null && remaining === null && rawUsed !== null && rawRemaining !== null) {
    limit = limit ?? rawUsed + rawRemaining;
    used = limit ? (rawUsed / limit) * 100 : 0;
    remaining = limit ? (rawRemaining / limit) * 100 : 100;
  } else if (used === null && rawUsed !== null && limit !== null && limit > 0) {
    used = (rawUsed / limit) * 100;
  } else if (remaining === null && rawRemaining !== null && limit !== null && limit > 0) {
    remaining = (rawRemaining / limit) * 100;
  }

  if (used === null && remaining !== null) used = 100 - remaining;
  if (remaining === null && used !== null) remaining = 100 - used;
  if (used === null || remaining === null) return null;

  const windowMinutes = inferWindowMinutes(name, raw);
  const resetAt = resetFrom(raw, checkedAt);
  const exhausted = raw.exhausted === true || raw.status === "rejected" || clampPercent(used) >= 100;

  return {
    name: displayName(name, raw, windowMinutes),
    usedPercent: round1(clampPercent(used)),
    remainingPercent: round1(clampPercent(remaining)),
    ...(limit !== null ? { limit } : {}),
    ...(rawRemaining !== null && unit !== "percent" ? { remaining: rawRemaining } : {}),
    unit,
    ...(windowMinutes ? { windowMinutes } : {}),
    kind: windowMinutes && windowMinutes > SHORT_WINDOW_MAX_MINUTES ? "long" : "short",
    ...(resetAt ? { resetAt } : {}),
    ...(exhausted ? { exhausted: true } : {}),
  };
}

function collectWindows(source) {
  if (Array.isArray(source)) {
    return source.flatMap((item, index) => {
      if (!isWindowLike(item)) return [];
      return [[item.name ?? item.id ?? `window-${index + 1}`, item]];
    });
  }
  if (!source || typeof source !== "object") return [];
  return Object.entries(source).flatMap(([name, value]) => {
    if (isWindowLike(value)) return [[name, value]];
    if (value && typeof value === "object" && Array.isArray(value.windows)) return collectWindows(value.windows);
    return [];
  });
}

function normalizeSnapshot(input, providerHint = "generic") {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("A JSON object with at least one rate-limit window is required.");
  }
  const provider = normalizeProvider(input.provider ?? input.platform ?? providerHint);
  const checkedAt = normalizeReset(input.checkedAt ?? input.checked_at) ?? new Date().toISOString();
  // A Claude Code statusline payload carries context_window.used_percentage
  // too; only its rate_limits block is quota. Never fall back to the root.
  const isStatusline = Boolean(input.session_id || input.transcript_path || input.context_window);
  const source = input.windows ?? input.rateLimits ?? input.rate_limits ?? input.limits ?? input.usage ?? (isStatusline ? null : input);
  const windows = collectWindows(source)
    .map(([name, raw]) => normalizeWindow(name, raw, checkedAt))
    .filter(Boolean);
  if (!windows.length) {
    throw new TypeError("No rate-limit windows found. Expected usedPercent, remainingPercent, utilization, or used/limit.");
  }
  return {
    version: 2,
    provider,
    checkedAt,
    ...(input.source ? { source: String(input.source) } : {}),
    windows,
  };
}

/** Like normalizeSnapshot, but returns null instead of throwing. */
function tryNormalizeSnapshot(input, providerHint) {
  try {
    return normalizeSnapshot(input, providerHint);
  } catch {
    return null;
  }
}

module.exports = {
  SHORT_WINDOW_MAX_MINUTES,
  normalizeProvider,
  normalizeSnapshot,
  tryNormalizeSnapshot,
  normalizeReset,
  numberFrom,
};
