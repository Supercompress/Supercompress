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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryAfterMs(res, attempt) {
  const raw = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
  const sec = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(sec) && sec >= 0) return Math.min(20_000, Math.max(500, sec * 1000));
  // 0.8s, 1.6s, 3.2s, 6.4s, 8s — wait out the single CPU slot instead of compiler fallback.
  return Math.min(8_000, 800 * 2 ** attempt);
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

/**
 * @param {string} context
 * @param {string} query
 * @returns {Promise<{compressed_text:string, original_tokens:number, kept_tokens:number, tokens_saved_pct:number, policy_name:string, mode:string, neural_keep_latency_ms:number}|null>}
 */
async function compressViaNeuralKeep(context, query) {
  if (!neuralKeepEnabled()) return null;
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
  const maxAttempts = 5;

  // Retry on 503 busy / transient 502/504 (Fly proxy blip or single-slot queue).
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remaining = budget - (Date.now() - tStart);
    if (remaining < 3_000) break;
    try {
      const { res, body, ms } = await fetchOnce(url, headers, context, query, remaining);
      if (res.status === 503 || res.status === 502 || res.status === 504) {
        lastErr = new Error(`neural-keep HTTP ${res.status}: ${body.detail || body.error || res.statusText}`);
        if (attempt < maxAttempts - 1) {
          await sleep(retryAfterMs(res, attempt));
          continue;
        }
        break;
      }
      if (!res.ok) {
        const detail = body.detail || body.error || res.statusText;
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
      if (/aborted|timeout|ECONNRESET|fetch failed|502|503|504/i.test(msg) && attempt < maxAttempts - 1) {
        await sleep(retryAfterMs(null, attempt));
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
};
