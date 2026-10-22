/**
 * Local snapshot cache + usage history under ~/.supercompress/limits/.
 *
 *   snapshots/<provider>.json   latest normalized snapshot per provider
 *   history/<provider>.jsonl    compact usage points used for burn-rate math
 *
 * Only rate-limit numbers are stored — never prompts, responses, or tokens.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeProvider, tryNormalizeSnapshot } = require("./normalize");

const MAX_HISTORY_BYTES = 256 * 1024;
const KEEP_HISTORY_LINES = 2000;
const MIN_APPEND_INTERVAL_MS = 60 * 1000;
const lastPoints = new Map();

function limitsDir() {
  const configDir = process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(os.homedir(), ".supercompress");
  return path.join(configDir, "limits");
}

function safeName(provider) {
  return normalizeProvider(provider).replace(/[^a-z0-9._-]/g, "_") || "generic";
}

function snapshotPath(provider) {
  return path.join(limitsDir(), "snapshots", `${safeName(provider)}.json`);
}

function historyPath(provider) {
  return path.join(limitsDir(), "history", `${safeName(provider)}.jsonl`);
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readSnapshot(provider) {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(provider), "utf8"));
  } catch {
    return null;
  }
}

function listSnapshots() {
  const dir = path.join(limitsDir(), "snapshots");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((n) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function toPoint(snapshot) {
  return {
    t: snapshot.checkedAt,
    w: snapshot.windows.map((w) => ({ n: w.name, u: w.usedPercent, ...(w.resetAt ? { r: w.resetAt } : {}) })),
  };
}

function readHistory(provider) {
  let text = "";
  try {
    text = fs.readFileSync(historyPath(provider), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((p) => p && p.t && Array.isArray(p.w));
}

function appendHistory(provider, snapshot) {
  const file = historyPath(provider);
  const point = toPoint(snapshot);
  if (!lastPoints.has(file)) {
    const history = readHistory(provider);
    lastPoints.set(file, history[history.length - 1] ?? null);
  }
  const last = lastPoints.get(file);
  if (last) {
    const elapsed = new Date(point.t).getTime() - new Date(last.t).getTime();
    const same = JSON.stringify(last.w) === JSON.stringify(point.w);
    if (elapsed < 0) return false; // out-of-order (older) sample
    if (same && elapsed < MIN_APPEND_INTERVAL_MS) return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(point)}\n`);
  lastPoints.set(file, point);
  try {
    if (fs.statSync(file).size > MAX_HISTORY_BYTES) {
      const kept = readHistory(provider).slice(-KEEP_HISTORY_LINES);
      writeAtomic(file, kept.map((p) => JSON.stringify(p)).join("\n") + "\n");
    }
  } catch {}
  return true;
}

/**
 * Persist a snapshot (raw or normalized). Returns the normalized snapshot, or
 * null if the payload had no usable windows. Older snapshots never overwrite
 * newer ones.
 */
function recordSnapshot(raw, providerHint) {
  const snapshot = tryNormalizeSnapshot(raw, providerHint);
  if (!snapshot) return null;
  const existing = readSnapshot(snapshot.provider);
  if (existing && new Date(existing.checkedAt).getTime() > new Date(snapshot.checkedAt).getTime()) {
    return existing;
  }
  writeAtomic(snapshotPath(snapshot.provider), JSON.stringify(snapshot, null, 2) + "\n");
  appendHistory(snapshot.provider, snapshot);
  return snapshot;
}

module.exports = {
  limitsDir,
  snapshotPath,
  historyPath,
  readSnapshot,
  listSnapshots,
  readHistory,
  appendHistory,
  recordSnapshot,
  toPoint,
};
