/**
 * Usage sources, in priority order per provider:
 *
 *   1. Explicit payload: --file / --json / stdin / SUPERCOMPRESS_LIMITS_SNAPSHOT
 *      (LIMITCHECK_SNAPSHOT is honored for limitcheck compatibility).
 *   2. Codex: zero-config from ~/.codex/sessions rate_limits events.
 *   3. Cached snapshots written by the local proxy (response headers) or by
 *      `supercompress limits ingest` (Claude Code statusline, harness hooks).
 *
 * The Codex reader only parses `token_count` events with rate limits; it
 * never reads prompts, responses, or tool output.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeProvider, normalizeSnapshot, tryNormalizeSnapshot } = require("./normalize");
const store = require("./store");

const MAX_FILES = 60;
const MAX_TOTAL_SCAN_BYTES = 64 * 1024 * 1024;
const EXTRA_FILES_AFTER_HIT = 4;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_POINTS = 400;

function newestJsonlFiles(root, limit = MAX_FILES) {
  if (!fs.existsSync(root)) return [];
  const stack = [root];
  const files = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          files.push({ path: p, modifiedAt: fs.statSync(p).mtimeMs });
        } catch {
          // Codex can rotate a session away mid-scan.
        }
      }
    }
  }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit);
}

function codexEvent(line) {
  if (!line.includes('"rate_limits"')) return null;
  try {
    const event = JSON.parse(line);
    const payload = event?.payload;
    if (event?.type !== "event_msg" || payload?.type !== "token_count" || !payload.rate_limits) return null;
    // Newer Codex builds emit token_count events with primary/secondary null
    // (credits-only). Those carry no window data — skip instead of failing.
    const snapshot = tryNormalizeSnapshot(
      { provider: "codex", checkedAt: event.timestamp, source: "codex-sessions", rate_limits: payload.rate_limits },
      "codex"
    );
    return snapshot;
  } catch {
    return null;
  }
}

/** Tail-scan one session file for rate-limit events (newest first). */
function codexEventsInFile(file, maxEvents) {
  const events = [];
  let fd;
  try {
    fd = fs.openSync(file, "r");
    let cursor = fs.fstatSync(fd).size;
    let scanned = 0;
    let suffix = "";
    while (cursor > 0 && scanned < MAX_SCAN_BYTES && events.length < maxEvents) {
      const length = Math.min(CHUNK_BYTES, cursor, MAX_SCAN_BYTES - scanned);
      cursor -= length;
      scanned += length;
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fd, buffer, 0, length, cursor);
      const lines = `${buffer.toString("utf8")}${suffix}`.split("\n");
      suffix = cursor === 0 ? "" : lines.shift() ?? "";
      for (let i = lines.length - 1; i >= 0 && events.length < maxEvents; i -= 1) {
        const event = codexEvent(lines[i]);
        if (event) events.push(event);
      }
    }
    if (suffix && events.length < maxEvents) {
      const event = codexEvent(suffix);
      if (event) events.push(event);
    }
  } catch {
    // unreadable session: ignore
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return events;
}

function codexSessionsRoot() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

/**
 * Latest Codex snapshot plus a usage history reconstructed from session logs
 * (free burn-rate data: every turn logs the current window usage).
 */
function readCodex({ sessionsRoot = codexSessionsRoot() } = {}) {
  // Walk sessions newest-first. Recent sessions may log only credits-only
  // events (primary/secondary null), so keep going until real window data
  // shows up, then read a few more files for burn-rate history.
  const events = [];
  let firstHit = -1;
  let scannedBytes = 0;
  const files = newestJsonlFiles(sessionsRoot);
  for (let i = 0; i < files.length; i += 1) {
    if (firstHit !== -1 && i > firstHit + EXTRA_FILES_AFTER_HIT) break;
    if (events.length >= MAX_POINTS || scannedBytes >= MAX_TOTAL_SCAN_BYTES) break;
    const found = codexEventsInFile(files[i].path, MAX_POINTS - events.length);
    try {
      scannedBytes += Math.min(fs.statSync(files[i].path).size, MAX_SCAN_BYTES);
    } catch {}
    if (found.length && firstHit === -1) firstHit = i;
    events.push(...found);
  }
  if (!events.length) return null;
  events.sort((a, b) => new Date(a.checkedAt).getTime() - new Date(b.checkedAt).getTime());
  return {
    snapshot: events[events.length - 1],
    points: events.slice(-MAX_POINTS).map(store.toPoint),
  };
}

/** Detect which harness is running this process (best effort). */
function detectHarness(env = process.env) {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_MANAGED_BY_NPM || env.CODEX_HOME) return "codex";
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return "cursor";
  if (env.OPENCODE || env.OPENCODE_SESSION) return "opencode";
  if (env.GROK_HOME || env.GROK_SESSION_ID) return "grok-build";
  if (env.GEMINI_CLI) return "gemini-cli";
  return null;
}

function explicitPayload({ raw, provider } = {}) {
  const text = raw ?? process.env.SUPERCOMPRESS_LIMITS_SNAPSHOT ?? process.env.LIMITCHECK_SNAPSHOT;
  if (!text) return null;
  const parsed = typeof text === "string" ? JSON.parse(text) : text;
  // Explicit input is authoritative: bad input is an error, not a silent fallback.
  return normalizeSnapshot({ source: "explicit", ...parsed }, provider ?? "generic");
}

/**
 * Collect every provider we have data for.
 * Returns [{ snapshot, points }] newest-first.
 */
function collect({ raw, provider, sessionsRoot } = {}) {
  const wanted = provider ? normalizeProvider(provider) : null;
  const results = new Map();
  const add = (snapshot, points) => {
    if (!snapshot) return;
    if (wanted && snapshot.provider !== wanted && wanted !== "generic") return;
    const prior = results.get(snapshot.provider);
    if (prior && new Date(prior.snapshot.checkedAt) >= new Date(snapshot.checkedAt)) return;
    results.set(snapshot.provider, { snapshot, points: points ?? store.readHistory(snapshot.provider) });
  };

  const explicit = explicitPayload({ raw, provider });
  if (explicit) {
    // An explicit payload is authoritative for this call.
    return [{ snapshot: explicit, points: store.readHistory(explicit.provider) }];
  }

  if (!wanted || wanted === "codex" || wanted === "generic") {
    const codex = readCodex({ sessionsRoot });
    if (codex) {
      const cachedPoints = store.readHistory("codex");
      add(codex.snapshot, mergePoints(codex.points, cachedPoints));
    }
  }

  for (const snapshot of store.listSnapshots()) add(snapshot);

  return [...results.values()].sort(
    (a, b) => new Date(b.snapshot.checkedAt).getTime() - new Date(a.snapshot.checkedAt).getTime()
  );
}

function mergePoints(a = [], b = []) {
  const byTime = new Map();
  for (const p of [...a, ...b]) byTime.set(p.t, p);
  return [...byTime.values()].sort((x, y) => new Date(x.t).getTime() - new Date(y.t).getTime());
}

module.exports = { readCodex, collect, detectHarness, codexSessionsRoot, newestJsonlFiles };
