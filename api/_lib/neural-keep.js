/**
 * Remote neural keep client — optional hosted relevance path for compress.
 *
 * Operator env (private): SC_NEURAL_KEEP_URL, SC_NEURAL_KEEP_SECRET,
 * SC_NEURAL_KEEP, SC_NEURAL_KEEP_TIMEOUT_MS.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ context: String(context || ""), query: String(query || "") }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
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
      neural_keep_latency_ms: Number(body.latency_ms) || (Date.now() - t0),
      lines_in: Number(body.lines_in) || 0,
      lines_kept: Number(body.lines_kept) || 0,
      threshold: Number(body.threshold) || 0,
    };
  } catch (err) {
    console.warn("[supercompress] neural-keep skipped:", err.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  neuralKeepEnabled,
  compressViaNeuralKeep,
};
