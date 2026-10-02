/**
 * Control Plane ops UI — demo + live insights renderer.
 * Confidential. No asks/prompts in the UI surface.
 */

const $ = (id) => document.getElementById(id);

const state = {
  mode: "demo",
  insights: null,
};

function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(Math.round(Number(n) || 0));
}

function fmtRatio(r) {
  if (r == null || !Number.isFinite(Number(r))) return "—";
  return `${Math.round(Number(r) * 1000) / 10}% kept`;
}

function setStatus(msg, tone = "") {
  const el = $("status");
  el.textContent = msg;
  el.dataset.tone = tone;
}

function animateCount(el, value, prefix = "$") {
  const target = Number(value) || 0;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    el.textContent = prefix === "$" ? fmtUsd(target) : fmtInt(target);
    return;
  }
  const start = performance.now();
  const dur = 900;
  const from = 0;
  function frame(t) {
    const p = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const cur = from + (target - from) * eased;
    el.textContent = prefix === "$" ? fmtUsd(cur) : fmtInt(cur);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function avgTokens(preview) {
  if (!preview?.length) return { original: 80000, retained: 20000 };
  const o = preview.reduce((s, r) => s + (r.original_tokens || 0), 0) / preview.length;
  const k = preview.reduce((s, r) => s + (r.retained_tokens || 0), 0) / preview.length;
  return { original: o, retained: k };
}

function renderBars(insights) {
  const preview = insights.records_preview || [];
  const { original, retained } = avgTokens(preview);
  const max = Math.max(original, 1);

  const lit = $("bar-litellm");
  lit.innerHTML = `
    <div class="row"><span>Client size</span><div class="track"><div class="fill" data-w="${(original / max) * 100}"></div></div><span class="val">${fmtInt(original)}</span></div>
    <div class="row"><span>Routable</span><div class="track"><div class="fill" data-w="${(original / max) * 100}"></div></div><span class="val">same</span></div>
  `;

  const sc = $("bar-sc");
  sc.innerHTML = `
    <div class="row"><span>Original</span><div class="track"><div class="fill" data-w="${(original / max) * 100}"></div></div><span class="val">${fmtInt(original)}</span></div>
    <div class="row"><span>Retained</span><div class="track"><div class="fill kept" data-w="${(retained / max) * 100}"></div></div><span class="val">${fmtInt(retained)}</span></div>
  `;

  requestAnimationFrame(() => {
    document.querySelectorAll(".token-bar .fill").forEach((el) => {
      el.style.width = `${el.dataset.w || 0}%`;
    });
  });
}

function render(insights) {
  state.insights = insights;
  const moat = insights.moat || {};
  const summary = insights.summary || {};

  $("headline").textContent = insights.headline || "Compress first. Route on what’s left.";
  animateCount($("dollars"), moat.dollars_avoided_total_est || summary.dollars_avoided_est || 0, "$");
  $("delta-sub").textContent = moat.vs_litellm || insights.lede || "";

  const vs = $("vs-strip");
  if (insights.comparison) {
    vs.hidden = false;
    vs.innerHTML = `<strong>LiteLLM:</strong> ${insights.comparison.litellm.routes_on}
      <span class="sep">·</span>
      <strong>SuperCompress:</strong> ${insights.comparison.supercompress.routes_on}
      <span class="sep">·</span>
      ${fmtInt(moat.unlock_count)} unlocks · ${fmtInt(moat.model_changed_count)} model shifts`;
  } else {
    vs.hidden = true;
  }

  $("m-req").textContent = fmtInt(summary.requests);
  $("m-chg").textContent = fmtInt(moat.model_changed_count);
  $("m-unl").textContent = fmtInt(moat.unlock_count);
  $("m-ratio").textContent = fmtRatio(summary.compression?.ratio);

  renderBars(insights);

  const unlocks = $("unlocks");
  const examples = moat.unlock_examples || [];
  if (!examples.length && !moat.unlock_count) {
    unlocks.innerHTML = `<span class="chip" style="color:var(--muted);border-color:var(--line);background:transparent">No context unlocks in this window — model changes may still save $</span>`;
  } else if (!examples.length) {
    unlocks.innerHTML = `<span class="chip">${fmtInt(moat.unlock_count)} unlock(s) recorded</span>`;
  } else {
    unlocks.innerHTML = examples
      .map(
        (e, i) =>
          `<span class="chip" style="animation-delay:${i * 60}ms">${e.without || "∅"} → ${e.with || "?"} · ${fmtInt(e.original_tokens)}→${fmtInt(e.retained_tokens)} tok</span>`
      )
      .join("");
  }

  const alerts = $("alerts");
  const list = insights.alerts || [];
  if (!list.length) {
    alerts.innerHTML = `<div class="alert" style="border-left-color:var(--good);background:color-mix(in oklab, var(--good) 6%, transparent)">No budget / error alerts in this window.</div>`;
  } else {
    alerts.innerHTML = list
      .map((a) => `<div class="alert" data-level="${a.level || "warn"}"><strong>${a.code}</strong> · ${JSON.stringify(a)}</div>`)
      .join("");
  }

  const rows = $("rows");
  const preview = insights.records_preview || [];
  if (!preview.length) {
    rows.innerHTML = `<tr><td colspan="5">No request preview on this payload. Live insights summarize ledger aggregates; demo includes a sample table.</td></tr>`;
  } else {
    rows.innerHTML = preview
      .map((r) => {
        const tok = `${fmtInt(r.original_tokens)}→${fmtInt(r.retained_tokens)}`;
        const ch = r.model_changed ? `<span class="changed">changed</span>` : "—";
        return `<tr>
          <td class="mono">${r.id}</td>
          <td>${r.agent_id || "—"}</td>
          <td class="mono">${tok}</td>
          <td>${r.model_routed || "—"} ${ch}</td>
          <td class="mono">${fmtUsd(r.dollars_avoided_est)}</td>
        </tr>`;
      })
      .join("");
  }
}

async function loadDemo() {
  state.mode = "demo";
  $("btn-demo").classList.add("active");
  setStatus("Loading offline demo…");
  const res = await fetch("./demo.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`demo.json ${res.status}`);
  const data = await res.json();
  render(data);
  setStatus("Demo mode — synthetic ledger via real economics math. Confidential.", "good");
}

async function loadLive() {
  state.mode = "live";
  $("btn-demo").classList.remove("active");
  const base = $("base").value.replace(/\/$/, "");
  const key = $("key").value.trim();
  if (!key) {
    setStatus("Paste an sc_ API key for live insights (requires SC_CP_OPS=1).", "bad");
    return;
  }
  setStatus("Fetching /v1/ops/insights…");
  const res = await fetch(`${base}/v1/ops/insights`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(`Live failed (${res.status}): ${body?.error?.message || res.statusText}`, "bad");
    return;
  }
  // Live payload may lack records_preview — synthesize empty preview
  if (!body.records_preview) body.records_preview = [];
  render(body);
  setStatus("Live insights loaded.", "good");
}

async function loadOtel() {
  if (state.mode === "demo") {
    setStatus("OTel export is live-only. Switch to Load live with SC_CP_OPS=1.", "bad");
    return;
  }
  const base = $("base").value.replace(/\/$/, "");
  const key = $("key").value.trim();
  if (!key) {
    setStatus("API key required for OTel export.", "bad");
    return;
  }
  const res = await fetch(`${base}/v1/ops/otel`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(`OTel failed (${res.status})`, "bad");
    return;
  }
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sc-cp-otel.json";
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("Downloaded OTel bundle (no asks/prompts).", "good");
}

$("btn-demo").addEventListener("click", () => {
  loadDemo().catch((err) => setStatus(String(err), "bad"));
});
$("btn-live").addEventListener("click", () => {
  loadLive().catch((err) => setStatus(String(err), "bad"));
});
$("btn-otel").addEventListener("click", () => {
  loadOtel().catch((err) => setStatus(String(err), "bad"));
});

loadDemo().catch((err) => setStatus(String(err), "bad"));
