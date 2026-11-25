/**
 * Gateway ops UI: aggregates and per-request routing decisions and savings.
 * Renders the `gateway` block of /v1/ops/insights. Metadata only, no prompts.
 */

const $ = (id) => document.getElementById(id);

const state = { mode: "demo" };

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function usd(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v === 0) return "$0";
  const a = Math.abs(v);
  const s = a >= 1 ? a.toFixed(2) : a >= 0.01 ? a.toFixed(3) : a.toFixed(5);
  return `${v < 0 ? "−" : ""}$${s}`;
}
const int = (n) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(Math.round(Number(n) || 0)));
const ms = (n) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`);
const pct = (r) => (r == null ? "—" : `${(Number(r) * 100).toFixed(1)}%`);

function setStatus(msg, tone = "") {
  const el = $("status");
  el.textContent = msg;
  el.dataset.tone = tone;
}

function renderKpis(g) {
  $("k-req").textContent = int(g.requests);
  $("k-req-s").textContent = `${int(g.auto_routed)} auto-routed · ${int(g.retried)} retried`;
  $("k-err").textContent = pct(g.error_rate);
  $("k-err-s").textContent = `${int(g.errors)} ${g.errors === 1 ? "error" : "errors"}`;
  $("k-lat").textContent = `${ms(g.latency_ms?.p50)} / ${ms(g.latency_ms?.p95)}`;
  $("k-ttft").textContent = `TTFT p50 ${ms(g.ttft_ms?.p50)} · p95 ${ms(g.ttft_ms?.p95)}`;
  $("k-spend").textContent = usd(g.spend_usd);
  $("k-list").textContent = `${usd(g.list_usd)} at list price`;
}

function renderSavings(g) {
  const s = g.savings || {};
  $("s-total").textContent = usd(s.total_usd);
  $("s-route").textContent = usd(s.routing_usd);
  $("s-comp").textContent = usd(s.compression_usd);
  const r = Math.max(0, Number(s.routing_usd) || 0);
  const c = Math.max(0, Number(s.compression_usd) || 0);
  const sum = r + c || 1;
  const [routeEl, compEl] = $("s-bar").children;
  requestAnimationFrame(() => {
    routeEl.style.width = `${(r / sum) * 100}%`;
    compEl.style.width = `${(c / sum) * 100}%`;
  });
}

function renderErrors(g) {
  const entries = Object.entries(g.errors_by_code || {}).sort((a, b) => b[1] - a[1]);
  $("errors").innerHTML = entries.length
    ? entries.map(([code, n]) => `<span class="chip">${esc(code)} · ${int(n)}</span>`).join("")
    : `<span class="chip ok">No errors in this window</span>`;
}

function savedCell(v) {
  if (v == null) return "—";
  return Number(v) < 0 ? `<span class="neg">${usd(v)}</span>` : usd(v);
}

function renderRows(g) {
  const rows = g.recent || [];
  if (!rows.length) {
    $("rows").innerHTML = `<tr><td colspan="8" class="muted">No requests recorded yet.</td></tr>`;
    return;
  }
  $("rows").innerHTML = rows
    .map((r) => {
      const when = r.created_at ? new Date(r.created_at).toLocaleTimeString() : "";
      const decision = [
        r.mode ? `<span class="tag">${esc(r.mode)}</span>` : "",
        r.tier != null ? `<span class="tag">tier ${esc(r.tier)}</span>` : "",
        r.stream ? `<span class="tag">stream</span>` : "",
      ].join("");
      const ok = !r.error_code;
      return `<tr>
        <td><span class="mono">${esc(r.id)}</span><span class="sub">${esc(when)}</span></td>
        <td><span class="mono">${esc(r.requested_model || "—")}</span> → <span class="mono">${esc(r.model || "—")}</span><span class="sub">${esc(r.provider || "")}</span></td>
        <td>${decision}<span class="sub">${esc(r.route_reason || "")}${r.retries ? ` · ${esc(r.retries)} ${r.retries === 1 ? "retry" : "retries"}` : ""}</span></td>
        <td class="num">${int(r.original_tokens)} → ${int(r.retained_tokens)}<span class="sub">${esc(r.compress_mode || "")}</span></td>
        <td class="num">${ms(r.ttft_ms)} / ${ms(r.latency_ms)}</td>
        <td class="num">${usd(r.charged_usd)}<span class="sub">list ${usd(r.list_usd)}</span></td>
        <td class="num">${savedCell(r.saved_routing_usd)} / ${savedCell(r.saved_compression_usd)}</td>
        <td class="${ok ? "status-ok" : "status-bad"}">${ok ? "200" : `${esc(r.http_status ?? "")} <span class="mono">${esc(r.error_code)}</span>`}</td>
      </tr>`;
    })
    .join("");
}

function render(insights) {
  const g = insights.gateway;
  if (!g) {
    setStatus("This API does not return the gateway block yet. Update the gateway.", "bad");
    return;
  }
  renderKpis(g);
  renderSavings(g);
  renderErrors(g);
  renderRows(g);
}

function setMode(mode) {
  state.mode = mode;
  $("btn-demo").classList.toggle("active", mode === "demo");
}

async function loadDemo() {
  setMode("demo");
  const res = await fetch("./demo.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`demo.json ${res.status}`);
  render(await res.json());
  setStatus("Demo data.", "good");
}

function liveTarget(path) {
  const base = $("base").value.replace(/\/$/, "");
  const key = $("key").value.trim();
  if (!key) {
    setStatus("Paste an sc_live_ API key to load live data.", "bad");
    return null;
  }
  return { url: `${base}${path}`, headers: { Authorization: `Bearer ${key}` } };
}

async function loadLive() {
  const t = liveTarget("/v1/ops/insights");
  if (!t) return;
  setStatus("Loading…");
  const res = await fetch(t.url, { headers: t.headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(`Live load failed (${res.status}): ${body?.error?.message || res.statusText}`, "bad");
    return;
  }
  setMode("live");
  render(body);
  setStatus(`Live · generated ${new Date(body.generated_at || Date.now()).toLocaleTimeString()}`, "good");
}

async function loadOtel() {
  const t = liveTarget("/v1/ops/otel?export=otel");
  if (!t) return;
  const res = await fetch(t.url, { headers: t.headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(`OTel export failed (${res.status})`, "bad");
    return;
  }
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sc-gateway-otel.json";
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("Downloaded the OTLP/JSON bundle.", "good");
}

const guard = (fn) => () => fn().catch((err) => setStatus(String(err), "bad"));
$("btn-demo").addEventListener("click", guard(loadDemo));
$("btn-live").addEventListener("click", guard(loadLive));
$("btn-otel").addEventListener("click", guard(loadOtel));
guard(loadDemo)();
