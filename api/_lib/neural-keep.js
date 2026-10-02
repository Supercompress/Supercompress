/**
 * Remote neural keep client — optional hosted relevance path for compress.
 *
 * Operator env (private): SC_NEURAL_KEEP_URL, SC_NEURAL_KEEP_SECRET,
 * SC_NEURAL_KEEP, SC_NEURAL_KEEP_TIMEOUT_MS.
 */

const DEFAULT_TIMEOUT_MS = 150_000;

function neuralKeepEnabled() {
  if (process.env.SC_NEURAL_KEEP === "0" || process.env.SC_NEURAL_KEEP === "false") return false;
  const base = String(process.env.SC_NEURAL_KEEP_URL || "").trim();
  return Boolean(base);
}

function baseUrl() {
  return String(process.env.SC_NEURAL_KEEP_URL || "").replace(/\/$/, "");
}

function timeoutMs() {
  const n = Number(process.env.SC_NEURAL_KEEP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** Rough token estimate — avoid Neural Keep for tiny contexts (compiler is enough). */
function roughTokens(text) {
  return Math.max(0, String(text || "").trim().split(/\s+/).filter(Boolean).length);
}

/**
 * Skip remote Neural Keep when context is tiny (compiler is enough).
 * Env: SC_NEURAL_KEEP_MIN_TOKENS (default 80). Set 0 to always try neural.
 * Was 600 — that skipped too many real agent dumps onto the weak compiler path.
 */
function belowNeuralMinTokens(context) {
  const raw = process.env.SC_NEURAL_KEEP_MIN_TOKENS;
  const min = raw == null || raw === "" ? 80 : Number(raw);
  if (!Number.isFinite(min) || min <= 0) return false;
  return roughTokens(context) < min;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function detailText(body) {
  const d = body && body.detail;
  if (d == null) return "";
  if (typeof d === "string") return d;
  try {
    return JSON.stringify(d);
  } catch {
    return String(d);
  }
}

function retryAfterMs(res, attempt, detail) {
  const raw = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
  const sec = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(sec) && sec >= 0) return Math.min(30_000, Math.max(1_000, sec * 1000));
  // model_loading / restarting needs a longer pause than a brief busy slot.
  if (/model_loading|restarting/i.test(String(detail || ""))) {
    return Math.min(25_000, 5_000 * (attempt + 1));
  }
  // busy / inference_timeout — back off hard; serial worker cannot absorb storms.
  if (/busy|inference_timeout/i.test(String(detail || ""))) {
    return Math.min(20_000, 4_000 * (attempt + 1));
  }
  return Math.min(10_000, 1_200 * 2 ** attempt);
}

async function fetchOnce(url, headers, context, query, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ context: String(context || ""), query: String(query || "") }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { res, body, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Soft wait for worker warm — never throws; compress still retries on 503.
 * Fly auto-stops when idle; cold load of v4-large is ~60–90s.
 */
async function waitReady(budgetMs) {
  const readyUrl = `${baseUrl()}/ready`;
  // Allow long cold-start budget (machine wake + model load).
  const deadline = Date.now() + Math.min(120_000, Math.max(0, budgetMs));
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5_000);
      const res = await fetch(readyUrl, { method: "GET", signal: ctrl.signal }).finally(() =>
        clearTimeout(timer)
      );
      if (res.ok) return true;
    } catch {
      // ignore — machine may still be starting
    }
    await sleep(2_000);
  }
  return false;
}

/**
 * @param {string} context
 * @param {string} query
 * @returns {Promise<{compressed_text:string, original_tokens:number, kept_tokens:number, tokens_saved_pct:number, policy_name:string, mode:string, neural_keep_latency_ms:number}|null>}
 */
async function compressViaNeuralKeep(context, query) {
  if (!neuralKeepEnabled()) return null;
  // Tiny contexts: fall through to local compiler — saves Fly CPU and avoids busy storms.
  if (belowNeuralMinTokens(context)) return null;
  const url = `${baseUrl()}/v1/compress`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const secret = String(process.env.SC_NEURAL_KEEP_SECRET || "").trim();
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const budget = timeoutMs();
  const tStart = Date.now();
  let lastErr = null;
  // Serial Fly worker: at most 2 attempts. Extra retries were the busy-storm source.
  const maxAttempts = 2;

  // Prefer a warm worker before the first compress (v4-large cold load is slow).
  // Cap so we don't stampede /ready under load.
  await waitReady(Math.min(25_000, Math.max(4_000, budget / 6)));

  // Retry once on 503 busy / model_loading / transient 502/504.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remaining = budget - (Date.now() - tStart);
    if (remaining < 3_000) break;
    try {
      const { res, body, ms } = await fetchOnce(url, headers, context, query, remaining);
      const detail = detailText(body) || body.error || res.statusText;
      if (res.status === 503 || res.status === 502 || res.status === 504) {
        lastErr = new Error(`neural-keep HTTP ${res.status}: ${detail}`);
        if (attempt < maxAttempts - 1) {
          await sleep(retryAfterMs(res, attempt, detail));
          continue;
        }
        break;
      }
      if (!res.ok) {
        throw new Error(`neural-keep HTTP ${res.status}: ${detail}`);
      }
      const compressed = String(body.compressed_text || "");
      if (!compressed && String(context || "").trim()) {
        throw new Error("neural-keep returned empty compressed_text");
      }
      return {
        compressed_text: compressed,
        original_tokens: Number(body.original_tokens) || 0,
        kept_tokens: Number(body.kept_tokens) || 0,
        tokens_saved_pct: Number(body.tokens_saved_pct) || 0,
        policy_name: String(body.policy_name || "SuperCompress Neural Keep"),
        mode: String(body.mode || "neural-keep"),
        neural_keep_latency_ms: Number(body.latency_ms) || ms,
        lines_in: Number(body.lines_in) || 0,
        lines_kept: Number(body.lines_kept) || 0,
        threshold: Number(body.threshold) || 0,
        checkpoint: body.checkpoint ? String(body.checkpoint) : undefined,
        params_m: Number(body.params_m) || undefined,
        weights_match_expected:
          typeof body.weights_match_expected === "boolean" ? body.weights_match_expected : undefined,
      };
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message ? err.message : err);
      if (/aborted|timeout|ECONNRESET|fetch failed|502|503|504|model_loading|restarting/i.test(msg) && attempt < maxAttempts - 1) {
        await sleep(retryAfterMs(null, attempt, msg));
        continue;
      }
      break;
    }
  }

  console.warn("[supercompress] neural-keep skipped:", lastErr && lastErr.message ? lastErr.message : lastErr);
  return null;
}

module.exports = {
  neuralKeepEnabled,
  compressViaNeuralKeep,
  roughTokens,
  belowNeuralMinTokens,
};
