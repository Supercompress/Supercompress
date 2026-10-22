/**
 * Turn upstream rate-limit response headers into a usage snapshot.
 *
 * Families covered (whatever the local proxy forwards to):
 *   - Anthropic subscription:  anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}
 *   - Anthropic API key:       anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}
 *   - OpenAI-compatible:       x-ratelimit-{limit,remaining,reset}-{requests,tokens}  (OpenAI, xAI, Groq, OpenRouter, …)
 *   - Codex backend:           x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at,reset-after-seconds}
 *   - Any 429:                 retry-after marks the tightest window exhausted until it passes.
 */

function headerGetter(headers) {
  if (!headers) return () => null;
  if (typeof headers.get === "function") {
    return (name) => {
      const value = headers.get(name);
      return value === null || value === undefined || value === "" ? null : String(value);
    };
  }
  const lower = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  return (name) => {
    const value = lower[name];
    return value === null || value === undefined || value === "" ? null : String(value);
  };
}

/** "6m0s", "1.5s", "20ms", "2h3m" → seconds. Also bare numbers (seconds). */
function parseDurationSeconds(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let match;
  while ((match = re.exec(text))) {
    matched = true;
    const n = Number(match[1]);
    total += match[2] === "h" ? n * 3600 : match[2] === "m" ? n * 60 : match[2] === "s" ? n : n / 1000;
  }
  return matched ? total : null;
}

function isoAfter(now, seconds) {
  return new Date(new Date(now).getTime() + seconds * 1000).toISOString();
}

function resetToIso(value, now) {
  if (value === null) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value.trim())) {
    // Epoch seconds/milliseconds vs. "seconds from now".
    if (numeric > 1_000_000_000) return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric).toISOString();
    return isoAfter(now, numeric);
  }
  const date = new Date(value);
  if (Number.isFinite(date.getTime())) return date.toISOString();
  const seconds = parseDurationSeconds(value);
  return seconds === null ? null : isoAfter(now, seconds);
}

function windowsFromHeaders(headers, now = new Date()) {
  const get = headerGetter(headers);
  const windows = [];

  // Anthropic unified (subscription) windows.
  for (const [key, name, minutes] of [["5h", "5h window", 300], ["7d", "weekly", 10080]]) {
    const utilization = get(`anthropic-ratelimit-unified-${key}-utilization`);
    if (utilization === null) continue;
    const reset = resetToIso(get(`anthropic-ratelimit-unified-${key}-reset`), now);
    windows.push({ name, utilization: Number(utilization), windowMinutes: minutes, ...(reset ? { resetAt: reset } : {}) });
  }

  // Codex backend windows.
  for (const slot of ["primary", "secondary"]) {
    const used = get(`x-codex-${slot}-used-percent`);
    if (used === null) continue;
    const minutes = Number(get(`x-codex-${slot}-window-minutes`)) || undefined;
    const reset = resetToIso(get(`x-codex-${slot}-reset-at`), now)
      ?? resetToIso(get(`x-codex-${slot}-reset-after-seconds`), now);
    windows.push({ name: slot, usedPercent: Number(used), ...(minutes ? { windowMinutes: minutes } : {}), ...(reset ? { resetAt: reset } : {}) });
  }

  // Anthropic API-key per-minute buckets.
  for (const bucket of ["requests", "tokens", "input-tokens", "output-tokens"]) {
    const limit = get(`anthropic-ratelimit-${bucket}-limit`);
    const remaining = get(`anthropic-ratelimit-${bucket}-remaining`);
    if (limit === null || remaining === null) continue;
    const reset = resetToIso(get(`anthropic-ratelimit-${bucket}-reset`), now);
    windows.push({ name: `${bucket} / min`, limit: Number(limit), remaining: Number(remaining), used: Number(limit) - Number(remaining), unit: bucket, windowMinutes: 1, ...(reset ? { resetAt: reset } : {}) });
  }

  // OpenAI-compatible buckets.
  for (const bucket of ["requests", "tokens"]) {
    const limit = get(`x-ratelimit-limit-${bucket}`);
    const remaining = get(`x-ratelimit-remaining-${bucket}`);
    if (limit === null || remaining === null) continue;
    const reset = resetToIso(get(`x-ratelimit-reset-${bucket}`), now);
    windows.push({ name: `${bucket} / min`, limit: Number(limit), remaining: Number(remaining), used: Number(limit) - Number(remaining), unit: bucket, windowMinutes: 1, ...(reset ? { resetAt: reset } : {}) });
  }

  return windows.filter((w) => Object.values(w).every((v) => typeof v !== "number" || Number.isFinite(v)));
}

/**
 * Build a raw snapshot (pre-normalize) from a response, or null when the
 * response carries no rate-limit information.
 */
function snapshotFromResponse(provider, { status, headers } = {}, now = new Date()) {
  const windows = windowsFromHeaders(headers, now);
  if (status === 429) {
    const get = headerGetter(headers);
    const retry = resetToIso(get("retry-after"), now);
    if (windows.length) {
      // Mark the window that is actually out as exhausted.
      const tightest = windows.reduce((a, b) => (remainingFraction(a) <= remainingFraction(b) ? a : b));
      tightest.exhausted = true;
      if (retry && !tightest.resetAt) tightest.resetAt = retry;
    } else if (retry) {
      windows.push({ name: "rate limit", usedPercent: 100, exhausted: true, windowMinutes: 1, resetAt: retry });
    }
  }
  if (!windows.length) return null;
  return { provider, checkedAt: new Date(now).toISOString(), source: "proxy-headers", windows };
}

function remainingFraction(w) {
  if (typeof w.utilization === "number") return 1 - (w.utilization <= 1 ? w.utilization : w.utilization / 100);
  if (typeof w.usedPercent === "number") return 1 - w.usedPercent / 100;
  if (w.limit) return w.remaining / w.limit;
  return 1;
}

module.exports = { windowsFromHeaders, snapshotFromResponse, parseDurationSeconds };
