/**
 * Public demo compress — compiler mode, no API key.
 * Rate-limited: 30 req/min per IP (memory + durable when Firestore is up).
 */
const { json, jsonWithRateLimit, checkRateLimit, clientIp, readBody, softProbe } = require("../_lib/http");
const { checkDurableRateLimit } = require("../_lib/rate-limit-durable");
const { compressAdaptive, getEngine } = require("../_lib/engine");

const DEMO_RPM = 30;
const DEMO_MAX_CHARS = 20_000;

const ASSUMPTIONS = {
  tokens_per_gpu_second: 2500,
  gpu_watts: 150,
  grid_kg_co2_per_kwh: 0.417,
  context_share_of_prefill: 0.55,
  liters_water_per_kwh: 1.8,
};

function envForTokenCount(tokenCount) {
  const effective = Math.max(tokenCount, 0) * ASSUMPTIONS.context_share_of_prefill;
  const gpuSeconds = effective / ASSUMPTIONS.tokens_per_gpu_second;
  const wattHours = (gpuSeconds * ASSUMPTIONS.gpu_watts) / 3600;
  const kwh = wattHours / 1000;
  return {
    watt_hours: wattHours,
    water_liters: kwh * ASSUMPTIONS.liters_water_per_kwh,
    co2_grams: kwh * ASSUMPTIONS.grid_kg_co2_per_kwh * 1000,
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST") {
    return softProbe(res, "Method not allowed", { allow: "POST" });
  }

  // ── Rate limit by IP (memory + durable when available) ──
  const ip = clientIp(req);
  const rlMem = checkRateLimit(`demo:${ip}`, DEMO_RPM);
  if (!rlMem.allowed) {
    return jsonWithRateLimit(res, 429, {
      detail: `Rate limit exceeded (${DEMO_RPM} requests/minute). Try again shortly or use your own API key via POST /api/v1/compress.`,
      retry_after_seconds: Math.max(1, Math.ceil((rlMem.resetMs - Date.now()) / 1000)),
    }, rlMem);
  }
  let rl = rlMem;
  try {
    const durable = await checkDurableRateLimit(`demo:${ip}`, DEMO_RPM, 60_000);
    if (durable.backend === "firestore") {
      if (!durable.allowed) {
        return jsonWithRateLimit(res, 429, {
          detail: `Rate limit exceeded (${DEMO_RPM} requests/minute). Try again shortly or use your own API key via POST /api/v1/compress.`,
          retry_after_seconds: Math.max(1, Math.ceil((durable.resetMs - Date.now()) / 1000)),
        }, durable);
      }
      rl = { ...durable, remaining: Math.min(durable.remaining, rlMem.remaining) };
    }
  } catch (_) {
    /* memory already applied */
  }

  try {
    const body = readBody(req);
    const context = body.context || "";
    const query = body.query || "Summarize this context.";

    if (!context.trim()) {
      return softProbe(res, "context required");
    }
    if (context.length > DEMO_MAX_CHARS) return jsonWithRateLimit(res, 422, {
      detail: `context too long (${DEMO_MAX_CHARS / 1000}k max for demo)`
    }, rl);

    const result = await compressAdaptive(context, query);
    const E = getEngine();
    const quality =
      result.answer_quality ?? E.answerQualityScore(context, result.compressed_text, query);
    const tokensSaved = Math.max(0, result.original_tokens - result.kept_tokens);
    const originalChars = context.length;
    const compressedChars = result.compressed_text.length;
    const charSavingsPct =
      originalChars > 0 ? Math.round((1 - compressedChars / originalChars) * 10000) / 100 : 0;
    const before = envForTokenCount(result.original_tokens);
    const after = envForTokenCount(result.kept_tokens);

    return jsonWithRateLimit(res, 200, {
      compressed_text: result.compressed_text,
      original_tokens: result.original_tokens,
      kept_tokens: result.kept_tokens,
      tokens_saved: tokensSaved,
      tokens_saved_pct: Math.round((result.tokens_saved_pct ?? result.kv_savings_pct ?? 0) * 100) / 100,
      // deprecated alias — same value as tokens_saved_pct
      kv_savings_pct: Math.round((result.tokens_saved_pct ?? result.kv_savings_pct ?? 0) * 100) / 100,
      original_chars: originalChars,
      compressed_chars: compressedChars,
      char_savings_pct: charSavingsPct,
      kept_line_ratio: result.kept_line_ratio,
      policy_name: result.policy_name,
      mode: "compiler",
      answer_quality: Math.round(quality * 1000) / 1000,
      keep_ratio: Math.round((result.keep_ratio ?? result.budget_ratio) * 1000) / 1000,
      important_kept_pct: result.important_kept_pct,
      compression_risk: result.compression_risk,
      environment: {
        power_mwh_before: Math.round(before.watt_hours * 1000 * 1000) / 1000,
        power_mwh_after: Math.round(after.watt_hours * 1000 * 1000) / 1000,
        power_mwh_saved: Math.round((before.watt_hours - after.watt_hours) * 1000 * 1000) / 1000,
        water_ml_saved: Math.max(0, Math.round((before.water_liters - after.water_liters) * 1_000_000) / 1000),
        co2_g_saved: Math.max(0, Math.round((before.co2_grams - after.co2_grams) * 1000) / 1000),
        assumptions: ASSUMPTIONS,
        note: "Estimates from token counts and documented assumptions — not live metering.",
      },
    }, rl);
  } catch (err) {
    console.error("demo compress error", err);
    return json(res, err.status || 500, { detail: err.message || String(err) });
  }
};
