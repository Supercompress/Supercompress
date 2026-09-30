/**
 * POST /api/arena/compare
 * Apples-to-apples compression arena: SuperCompress v2 vs selectable comparators.
 * Same token estimator + answer-retention heuristic for every side.
 *
 * Comparators (body.compare: string[] — default ["headroom","rtk","truncation"]):
 *   headroom    — HEADROOM_API_BASE POST /v1/compress, else local python headroom
 *   rtk         — real rtk binary (RTK_BIN or `rtk` on PATH), stdin→stdout
 *   llmlingua   — local python llmlingua-2 if installed
 *   truncation  — keep last 35% chars (in-process, always available)
 *   supercompress-v1 — the v1 JS compiler engine + MLP (in-process, always available)
 *
 * Every comparator either RUNS for real or reports status "unavailable" with an
 * honest hint. No simulated numbers.
 */
const { json, jsonWithRateLimit, checkRateLimit, clientIp, readBody } = require("../_lib/http");
const { compressAdaptive, getEngine } = require("../_lib/engine");
const { spawnSync } = require("child_process");

// v1 engine: the original JS compiler + ~10k-param MLP, bundled with the function.
require("../_lib/compress-engine.js");
const V1_ENGINE = globalThis.SuperCompressEngine;
const V1_MODEL = require("../_lib/model.json");

const RPM = 20;
const MAX_CHARS = 40_000;
const PRICE_PER_MTOK_IN = 2.5; // illustrative GPT-4o-class input $/1M — shown as estimate only
const DEFAULT_COMPARE = ["headroom", "rtk", "truncation"];
const KNOWN_COMPARATORS = ["headroom", "rtk", "llmlingua", "truncation", "supercompress-v1"];

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

// ── Hosted arena tools (Fly neural-keep service also hosts real comparators) ─

function arenaToolsBase() {
  return String(process.env.ARENA_TOOLS_URL || process.env.SC_NEURAL_KEEP_URL || "").replace(/\/$/, "");
}

async function runToolsHttp(pathname, payload, timeoutMs = 60000) {
  const base = arenaToolsBase();
  if (!base) return { ok: false, error: "no arena tools service configured" };
  const headers = { "Content-Type": "application/json" };
  const secret = String(process.env.SC_NEURAL_KEEP_SECRET || "").trim();
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}${pathname}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${String(body.detail || "").slice(0, 200)}`, ms: Date.now() - t0 };
    }
    return { ok: Boolean(body.text), text: body.text || "", ms: body.ms || Date.now() - t0, source: body.source || "hosted" };
  } catch (e) {
    return { ok: false, error: e.message || "fetch failed", ms: Date.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}

// ── Headroom ────────────────────────────────────────────────────────────────

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

async function runHeadroom(context, query, body) {
  let hr = { ok: false, error: "not attempted", ms: 0 };
  const apiBase = process.env.HEADROOM_API_BASE || body.headroom_api_base || "";
  const apiKey = process.env.HEADROOM_API_KEY || body.headroom_api_key || "";
  if (apiBase) {
    hr = await runHeadroomHttp(context, query, apiBase, apiKey);
  }
  if (!hr.ok && arenaToolsBase()) {
    const hosted = await runToolsHttp("/arena/headroom", { context, query }, 90000);
    if (hosted.ok) hr = hosted;
    else hr = { ...hr, hosted_error: hosted.error };
  }
  if (!hr.ok) {
    const py = runHeadroomPython(context, query);
    if (py.ok) hr = py;
    else if (!apiBase) hr = { ...hr, ...py };
  }
  if (!hr.ok) {
    hr.hint =
      "Headroom runs on the hosted arena tools service, HEADROOM_API_BASE, or the local headroom Python package — none were reachable.";
  }
  return hr;
}

// ── RTK (Rust Token Killer) ─────────────────────────────────────────────────

function findRtkBin() {
  if (process.env.RTK_BIN) return process.env.RTK_BIN;
  const which = spawnSync("which", ["rtk"], { encoding: "utf8", timeout: 3000 });
  const p = (which.stdout || "").trim();
  return which.status === 0 && p ? p : null;
}

async function runRtk(context) {
  if (arenaToolsBase()) {
    const hosted = await runToolsHttp("/arena/rtk", { context }, 45000);
    if (hosted.ok) return hosted;
  }
  const bin = findRtkBin();
  if (!bin) {
    return {
      ok: false,
      error: "rtk not reachable (no hosted arena tools service, no local binary)",
      hint: "RTK runs for real on the hosted arena tools service, or install rtk (github.com/rtk-ai/rtk) locally and set RTK_BIN.",
      ms: 0,
    };
  }
  const args = process.env.RTK_ARGS ? process.env.RTK_ARGS.split(/\s+/) : [];
  const t0 = Date.now();
  const res = spawnSync(bin, args, {
    input: context,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  if (res.status !== 0 || res.error) {
    return {
      ok: false,
      error: (res.error?.message || res.stderr || "rtk failed").slice(0, 400),
      hint: "rtk ran but exited non-zero; check RTK_ARGS.",
      ms,
    };
  }
  const text = String(res.stdout || "");
  return { ok: Boolean(text.trim()), text, ms, source: bin };
}

// ── LLMLingua-2 ─────────────────────────────────────────────────────────────

function runLLMLingua(context, query) {
  const script = `
import json, sys, time
ctx = sys.stdin.read()
q = sys.argv[1]
t0 = time.time()
text = ""
err = None
try:
    from llmlingua import PromptCompressor
    pc = PromptCompressor(model_name="microsoft/llmlingua-2-xlm-roberta-large-meetingbank", use_llmlingua2=True, device_map="cpu")
    r = pc.compress_prompt(ctx, question=q)
    text = r.get("compressed_prompt", "") if isinstance(r, dict) else str(r)
except Exception as e:
    err = f"{type(e).__name__}: {e}"
ms = int((time.time() - t0) * 1000)
print(json.dumps({"text": text, "ms": ms, "error": err}))
`;
  const py = process.env.ARENA_PYTHON || "/opt/homebrew/bin/python3.11";
  const t0 = Date.now();
  const res = spawnSync(py, ["-c", script, query], {
    input: context,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const wall = Date.now() - t0;
  if (res.status !== 0) {
    return {
      ok: false,
      error: (res.stderr || res.stdout || "python failed").slice(0, 400),
      hint: "Install the llmlingua Python package to enable LLMLingua-2 arena compares (local only — too heavy for serverless).",
      ms: wall,
    };
  }
  try {
    const parsed = JSON.parse(res.stdout.trim().split("\n").pop());
    if (parsed.error && !parsed.text) {
      return {
        ok: false,
        error: String(parsed.error).slice(0, 400),
        hint: "Install the llmlingua Python package to enable LLMLingua-2 arena compares (local only — too heavy for serverless).",
        ms: parsed.ms || wall,
      };
    }
    return { ok: Boolean(parsed.text), text: parsed.text || "", ms: parsed.ms || wall, source: "python" };
  } catch (e) {
    return { ok: false, error: `parse: ${e.message}`, ms: wall };
  }
}

// ── In-process comparators (always real) ────────────────────────────────────

function runTruncation(context) {
  const t0 = Date.now();
  const keep = Math.max(1, Math.floor(context.length * 0.35));
  const text = context.slice(-keep);
  return { ok: true, text, ms: Date.now() - t0, source: "in-process (keep last 35% chars)" };
}

function runV1(context, query) {
  const t0 = Date.now();
  try {
    const r = V1_ENGINE.compressAdaptive(context, query, V1_MODEL);
    const text = r.compressed_text || r.text || "";
    return { ok: Boolean(text.trim()), text, ms: Date.now() - t0, source: "in-process (JS compiler + MLP)" };
  } catch (e) {
    return { ok: false, error: e.message || "v1 engine failed", ms: Date.now() - t0 };
  }
}

// ── Packing / winner logic ──────────────────────────────────────────────────

const DISPLAY_NAMES = {
  headroom: "Headroom",
  rtk: "RTK",
  llmlingua: "LLMLingua-2",
  truncation: "Truncation",
  "supercompress-v1": "SuperCompress v1",
};

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

function packUnavailable(name, result) {
  return {
    name,
    status: "unavailable",
    error: result.error || `${name} not reachable`,
    hint: result.hint || "",
  };
}

function pickWinner(sc, comparators) {
  const contenders = [["SuperCompress", sc]];
  for (const [id, side] of Object.entries(comparators)) {
    if (side.status !== "unavailable") contenders.push([DISPLAY_NAMES[id] || id, side]);
  }
  if (contenders.length === 1) return { system: "SuperCompress", reason: "no_comparators_available" };
  // Primary: answer retained. Secondary: cost/success. Tie-break: cut.
  let best = contenders[0];
  let reason = "answer_retained";
  for (const cand of contenders.slice(1)) {
    const [, a] = best;
    const [, b] = cand;
    if (b.answer_retained && !a.answer_retained) {
      best = cand;
      reason = "answer_retained";
      continue;
    }
    if (!b.answer_retained && a.answer_retained) continue;
    const ac = a.cost_per_success_usd;
    const bc = b.cost_per_success_usd;
    if (ac != null && bc != null && bc !== ac) {
      if (bc < ac) {
        best = cand;
        reason = "cost_per_success";
      }
      continue;
    }
    if (b.removed_pct > a.removed_pct) {
      best = cand;
      reason = "removed_pct";
    }
  }
  return { system: best[0], reason };
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

    let compare = Array.isArray(body.compare) ? body.compare.map(String) : DEFAULT_COMPARE;
    compare = compare.filter((c) => KNOWN_COMPARATORS.includes(c));
    if (!compare.length) compare = DEFAULT_COMPARE;

    const engine = getEngine();
    let scResult;
    let scText = "";
    let scMs = 0;
    try {
      const tSc = Date.now();
      scResult = await compressAdaptive(context, query);
      scMs = Date.now() - tSc;
      scText = scResult.compressed_text || scResult.text || "";
      if (!scText.trim()) {
        return jsonWithRateLimit(res, 500, { detail: "SuperCompress returned empty output" }, rl);
      }
    } catch (compressErr) {
      return jsonWithRateLimit(
        res,
        500,
        { detail: `SuperCompress failed: ${compressErr.message || "compress error"}` },
        rl
      );
    }

    const supercompress = packSide("SuperCompress", context, scText, query, scMs, engine, {
      engine: scResult.mode || scResult.policy_name || "adaptive",
    });

    const comparators = {};
    for (const id of compare) {
      let result;
      if (id === "headroom") result = await runHeadroom(context, query, body);
      else if (id === "rtk") result = await runRtk(context);
      else if (id === "llmlingua") result = runLLMLingua(context, query);
      else if (id === "truncation") result = runTruncation(context);
      else if (id === "supercompress-v1") result = runV1(context, query);
      else continue;

      comparators[id] = result.ok
        ? packSide(DISPLAY_NAMES[id], context, result.text, query, result.ms, engine, { source: result.source })
        : packUnavailable(DISPLAY_NAMES[id], result);
    }

    // Back-compat: keep top-level headroom field.
    const headroom =
      comparators.headroom ||
      packUnavailable("Headroom", { error: "not selected", hint: "Add \"headroom\" to compare[]" });

    const winner = pickWinner(supercompress, comparators);

    const availableComparators = Object.values(comparators).filter((c) => c.status !== "unavailable");
    const broke_supercompress = availableComparators.some(
      (c) =>
        c.answer_retained &&
        (!supercompress.answer_retained ||
          (supercompress.cost_per_success_usd != null &&
            c.cost_per_success_usd != null &&
            c.cost_per_success_usd < supercompress.cost_per_success_usd))
    );

    return jsonWithRateLimit(
      res,
      200,
      {
        arena: "supercompress-context-compression-arena",
        version: "v2",
        methodology: {
          token_estimator: "chars/4 (identical for every side)",
          answer_retained: "engine.answerQualityScore >= 0.85 (identical for every side)",
          cost_per_success_usd: `tokens_out/1e6 * ${PRICE_PER_MTOK_IN} (illustrative input price; failed retention → null)`,
          killer_metric: "cost_per_success_usd",
          comparators: "each comparator runs for real or reports status=unavailable — nothing is simulated",
        },
        query,
        context_chars: context.length,
        compare,
        supercompress,
        comparators,
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
