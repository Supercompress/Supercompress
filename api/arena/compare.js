/**
 * POST /api/arena/compare
 * Apples-to-apples SuperCompress vs Headroom for the Compression Arena.
 * Same token estimator + answer-retention heuristic for both sides.
 *
 * Headroom sources (first hit wins):
 *   1) HEADROOM_API_BASE (+ optional HEADROOM_API_KEY) → POST /v1/compress
 *   2) local `python3 -c` headroom.compress if importable
 * If neither works, returns headroom.status = "unavailable" (SC still runs).
 */
const { json, jsonWithRateLimit, checkRateLimit, clientIp, readBody } = require("../_lib/http");
const { compressAdaptive, getEngine } = require("../_lib/engine");
const { spawnSync } = require("child_process");

const RPM = 20;
const MAX_CHARS = 40_000;
const PRICE_PER_MTOK_IN = 2.5; // illustrative GPT-4o-class input $/1M — shown as estimate only

function roughTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  return Math.max(1, Math.round(s.length / 4));
}

function answerRetained(engine, original, compressed, query) {
  try {
    const q = engine.answerQualityScore(original, compressed, query);
    return {
      score: Number(q) || 0,
      ok: (Number(q) || 0) >= 0.85,
    };
  } catch {
    return { score: 0, ok: false };
  }
}

function costPerSuccessfulTask(tokensOut, retainedOk) {
  if (!retainedOk) return null; // failed task → no finite cost/success
  return (tokensOut / 1e6) * PRICE_PER_MTOK_IN;
}

async function runHeadroomHttp(context, query, apiBase, apiKey) {
  const base = String(apiBase || "").replace(/\/$/, "");
  const messages = [
    { role: "system", content: "Use the provided context to answer." },
    { role: "user", content: `CONTEXT:\n${context}\n\nREQUEST: ${query}` },
  ];
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const t0 = Date.now();
    const res = await fetch(`${base}/v1/compress`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messages, model: "gpt-4o-mini" }),
      signal: ctrl.signal,
    });
    const ms = Date.now() - t0;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, ms };
    }
    const msgs = body.messages || body.compressed_messages || [];
    let text = "";
    for (const m of msgs) {
      if (m && m.role === "user" && m.content) {
        text = String(m.content);
        break;
      }
    }
    if (!text && typeof body.compressed === "string") text = body.compressed;
    if (!text && typeof body.text === "string") text = body.text;
    return { ok: Boolean(text), text, ms, source: "http" };
  } finally {
    clearTimeout(t);
  }
}

function runHeadroomPython(context, query) {
  const script = `
import json, sys, time
ctx = sys.stdin.read()
q = sys.argv[1]
t0 = time.time()
text = ""
err = None
try:
    from headroom.transforms.kompress_compressor import KompressCompressor
    k = KompressCompressor()
    if not k.is_ready():
        k.preload()
    r = k.compress(ctx, question=q)
    text = str(getattr(r, "compressed", "") or "")
except Exception as e1:
    try:
        from headroom import compress
        messages = [
            {"role": "system", "content": "Use the provided context to answer."},
            {"role": "user", "content": "CONTEXT:\\n" + ctx + "\\n\\nREQUEST: " + q},
        ]
        try:
            from headroom.compress import CompressConfig
            cfg = CompressConfig(compress_user_messages=True, protect_recent=0, min_tokens_to_compress=20)
            result = compress(messages, model="gpt-4o-mini", model_limit=128000, optimize=True, config=cfg)
        except Exception:
            result = compress(messages, model="gpt-4o-mini", model_limit=128000, optimize=True)
        for m in (getattr(result, "messages", None) or []):
            role = m.get("role") if isinstance(m, dict) else getattr(m, "role", None)
            content = m.get("content") if isinstance(m, dict) else getattr(m, "content", None)
            if role == "user" and content:
                text = str(content)
                break
    except Exception as e2:
        err = f"{type(e1).__name__}: {e1} | {type(e2).__name__}: {e2}"
ms = int((time.time() - t0) * 1000)
print(json.dumps({"text": text, "ms": ms, "error": err}))
`;
  const py = process.env.ARENA_PYTHON || "/opt/homebrew/bin/python3.11";
  const t0 = Date.now();
  const res = spawnSync(py, ["-c", script, query], {
    input: context,
    encoding: "utf8",
    timeout: 90000,
    env: { ...process.env, PYTHONPATH: [process.env.PYTHONPATH, "/tmp/hr-pkgs"].filter(Boolean).join(":") },
    maxBuffer: 20 * 1024 * 1024,
  });
  const wall = Date.now() - t0;
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "python failed").slice(0, 400), ms: wall };
  }
  try {
    const parsed = JSON.parse(res.stdout.trim().split("\n").pop());
    if (parsed.error && !parsed.text) {
      return { ok: false, error: String(parsed.error).slice(0, 400), ms: parsed.ms || wall };
    }
    return { ok: Boolean(parsed.text), text: parsed.text || "", ms: parsed.ms || wall, source: "python" };
  } catch (e) {
    return { ok: false, error: `parse: ${e.message}`, ms: wall };
  }
}

function packSide(name, original, compressed, query, ms, engine, extra = {}) {
  const tokens_in = roughTokens(original);
  const tokens_out = roughTokens(compressed);
  const removed_pct = tokens_in > 0 ? ((tokens_in - tokens_out) / tokens_in) * 100 : 0;
  const retained = answerRetained(engine, original, compressed, query);
  const cost = costPerSuccessfulTask(tokens_out, retained.ok);
  return {
    name,
    tokens_in,
    tokens_out,
    removed_pct: Math.round(removed_pct * 10) / 10,
    answer_retained: retained.ok,
    answer_quality: Math.round(retained.score * 1000) / 1000,
    latency_ms: ms,
    cost_per_success_usd: cost == null ? null : Math.round(cost * 1e6) / 1e6,
    compressed_preview: String(compressed || "").slice(0, 4000),
    ...extra,
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST") return json(res, 405, { detail: "Method not allowed" });

  const ip = clientIp(req);
  const rl = checkRateLimit(`arena:${ip}`, RPM);
  if (!rl.allowed) {
    return jsonWithRateLimit(res, 429, { detail: `Rate limit (${RPM}/min). Slow down.` }, rl);
  }

  try {
    const body = readBody(req);
    const context = String(body.context || "");
    const query = String(body.query || "").trim() || "What is the critical answer in this context?";
    if (!context.trim()) {
      return jsonWithRateLimit(res, 422, { detail: "context required" }, rl);
    }
    if (context.length > MAX_CHARS) {
      return jsonWithRateLimit(res, 422, { detail: `context too long (${MAX_CHARS} max)` }, rl);
    }

    const engine = getEngine();
    const tSc = Date.now();
    const scResult = await compressAdaptive(context, query);
    const scMs = Date.now() - tSc;
    const scText = scResult.compressed_text || scResult.text || "";

    let hr = { ok: false, error: "not attempted", ms: 0 };
    const apiBase = process.env.HEADROOM_API_BASE || body.headroom_api_base || "";
    const apiKey = process.env.HEADROOM_API_KEY || body.headroom_api_key || "";
    if (apiBase) {
      hr = await runHeadroomHttp(context, query, apiBase, apiKey);
    }
    if (!hr.ok) {
      const py = runHeadroomPython(context, query);
      if (py.ok) hr = py;
      else if (!apiBase) hr = py;
      else hr = { ...hr, python_error: py.error };
    }

    const supercompress = packSide("SuperCompress", context, scText, query, scMs, engine, {
      engine: scResult.mode || scResult.policy_name || "adaptive",
    });

    let headroom;
    if (hr.ok) {
      headroom = packSide("Headroom", context, hr.text, query, hr.ms, engine, { source: hr.source });
    } else {
      headroom = {
        name: "Headroom",
        status: "unavailable",
        error: hr.error || "Headroom not reachable",
        hint: "Set HEADROOM_API_BASE to a Headroom /v1/compress service, or install the headroom Python package for local arena compares.",
      };
    }

    const winner = (() => {
      if (!hr.ok) return { system: "SuperCompress", reason: "headroom_unavailable" };
      const a = supercompress;
      const b = headroom;
      // Primary: cost per successful task (lower wins). Failed retention loses.
      if (a.answer_retained && !b.answer_retained) return { system: "SuperCompress", reason: "answer_retained" };
      if (!a.answer_retained && b.answer_retained) return { system: "Headroom", reason: "answer_retained" };
      if (a.answer_retained && b.answer_retained) {
        if (a.cost_per_success_usd != null && b.cost_per_success_usd != null) {
          if (a.cost_per_success_usd < b.cost_per_success_usd) return { system: "SuperCompress", reason: "cost_per_success" };
          if (b.cost_per_success_usd < a.cost_per_success_usd) return { system: "Headroom", reason: "cost_per_success" };
        }
      }
      // Tie-break: higher removal with retained answer
      if (a.answer_retained && b.answer_retained) {
        if (a.removed_pct > b.removed_pct) return { system: "SuperCompress", reason: "removed_pct" };
        if (b.removed_pct > a.removed_pct) return { system: "Headroom", reason: "removed_pct" };
      }
      return { system: "tie", reason: "within_noise" };
    })();

    const broke_supercompress =
      hr.ok &&
      headroom.answer_retained &&
      (!supercompress.answer_retained ||
        (supercompress.cost_per_success_usd != null &&
          headroom.cost_per_success_usd != null &&
          headroom.cost_per_success_usd < supercompress.cost_per_success_usd));

    return jsonWithRateLimit(
      res,
      200,
      {
        arena: "supercompress-context-compression-arena",
        version: "v2-preview",
        methodology: {
          token_estimator: "chars/4 (identical for both)",
          answer_retained: "engine.answerQualityScore >= 0.85 (identical for both)",
          cost_per_success_usd: `tokens_out/1e6 * ${PRICE_PER_MTOK_IN} (illustrative input price; failed retention → null)`,
          killer_metric: "cost_per_success_usd",
        },
        query,
        context_chars: context.length,
        supercompress,
        headroom,
        winner,
        broke_supercompress,
        assumptions: { price_per_mtok_input_usd: PRICE_PER_MTOK_IN },
      },
      rl
    );
  } catch (err) {
    return jsonWithRateLimit(res, 500, { detail: err.message || "arena failed" }, rl);
  }
};
