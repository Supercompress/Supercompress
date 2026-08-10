/**
 * SuperCompress API Dashboard — Firebase auth + key management
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence,
  getAdditionalUserInfo,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

const API_BASE = window.SC_API_BASE || "";
const SESSION_KEY = "sc_dash_session";
const SECRET_KEY = "sc_last_api_secret";

function cleanConfigValue(value) {
  // Strip whitespace and literal "\n" / "\r" leftovers from poorly pasted Vercel env values.
  return String(value || "")
    .replace(/\\[nr]/gi, "")
    .replace(/[\r\n\t]/g, "")
    .trim()
    .split(/\s+/)[0] || "";
}

function normalizeFirebaseConfig(source = {}) {
  return {
    apiKey: cleanConfigValue(source.apiKey),
    authDomain: cleanConfigValue(source.authDomain),
    projectId: cleanConfigValue(source.projectId),
    storageBucket: cleanConfigValue(source.storageBucket),
    messagingSenderId: cleanConfigValue(source.messagingSenderId),
    appId: cleanConfigValue(source.appId),
  };
}

let cfg = normalizeFirebaseConfig(window.SC_FIREBASE_CONFIG || {});

const $ = (id) => document.getElementById(id);
const viewAuth = $("view-auth");
const viewDash = $("view-dashboard");
const authError = $("auth-error");
const keysGrid = $("keys-grid");
const usageTbody = $("usage-tbody");

let idToken = null;
let currentUser = null;
let keysData = [];
let usageData = {};
let accountUsage = null;
let codingAgentUsage = {};
let agentPluginLink = { linked: false };
let renameKeyId = null;
let auth = null;
let apiMode = "remote";
let authResolved = false;
let snippetTab = "python";
let modalSnippetTab = "python";
let lastCreatedSecret = null;
let defaultKeyProvisioning = false;
let lastBillingSub = null;

const AUTH_NETWORK_MESSAGE =
  "Signed in, but Firebase could not issue a session token. Check your network/ad blocker/VPN and refresh, then try again.";

function apiBaseUrl() {
  if (API_BASE) return API_BASE.replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "https://supercompress.dev";
}

function integrationSnippets(apiKey) {
  const key = apiKey || "sc_live_YOUR_KEY";
  const base = apiBaseUrl();
  return {
    python: `# 1. pip install git+https://github.com/Supercompress/Supercompress.git
# 2. export SUPERCOMPRESS_API_KEY="${key}"

from supercompress import SuperCompress

sc = SuperCompress()  # reads SUPERCOMPRESS_API_KEY
out = sc.compress(your_context, "Your question here")
print(out.compressed_text)  # → send to your LLM`,
    node: `const res = await fetch("${base}/api/v1/compress", {
  method: "POST",
  headers: {
    "X-API-Key": process.env.SUPERCOMPRESS_API_KEY ?? "${key}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    context: yourContext,
    query: "Your question here",
  }),
});
const { compressed_text } = await res.json();`,
    curl: `export SUPERCOMPRESS_API_KEY="${key}"

curl -X POST ${base}/api/v1/compress \\
  -H "X-API-Key: $SUPERCOMPRESS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"context":"…","query":"…"}'`,
  };
}

function renderSnippet(scope = "dash") {
  const key =
    scope === "modal" && lastCreatedSecret
      ? lastCreatedSecret
      : keysData[0]?.prefix
        ? `${keysData[0].prefix}…`
        : "sc_live_YOUR_KEY";
  const tab = scope === "modal" ? modalSnippetTab : snippetTab;
  const snippets = integrationSnippets(scope === "modal" ? lastCreatedSecret || key : key);
  const text = snippets[tab] || snippets.python;
  const el = scope === "modal" ? $("modal-snippet-code") : $("dash-snippet-code");
  if (el) el.textContent = text;
}

function initSnippetTabs() {
  document.querySelectorAll(".dash-snippet-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const scope = btn.dataset.snippetScope || "dash";
      const tab = btn.dataset.snippet;
      if (scope === "modal") modalSnippetTab = tab;
      else snippetTab = tab;

      const group = btn.closest(".dash-snippet-tabs");
      group?.querySelectorAll(".dash-snippet-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderSnippet(scope);
    });
  });

  $("btn-copy-snippet")?.addEventListener("click", async () => {
    const text = $("dash-snippet-code")?.textContent || "";
    await navigator.clipboard.writeText(text);
    $("btn-copy-snippet").textContent = "Copied!";
    setTimeout(() => ($("btn-copy-snippet").textContent = "Copy code"), 2000);
  });

  $("btn-copy-modal-snippet")?.addEventListener("click", async () => {
    const text = $("modal-snippet-code")?.textContent || "";
    await navigator.clipboard.writeText(text);
    $("btn-copy-modal-snippet").textContent = "Copied!";
    setTimeout(() => ($("btn-copy-modal-snippet").textContent = "Copy code"), 2000);
  });

  renderSnippet("dash");
}

function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (_) {
    /* private browsing */
  }
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (_) {
    /* ignore */
  }
}

async function ensureFreshToken(force = false) {
  if (auth?.currentUser) {
    try {
      idToken = await auth.currentUser.getIdToken(force);
    } catch (err) {
      idToken = null;
      if (isAuthNetworkError(err)) {
        throw new Error(AUTH_NETWORK_MESSAGE);
      }
      throw err;
    }
  }
}

function isAuthNetworkError(err) {
  const code = String(err?.code || "");
  const message = String(err?.message || "");
  return code === "auth/network-request-failed" || /network-request-failed|ERR_CONNECTION_RESET/i.test(message);
}

async function getUserToken(user, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await user.getIdToken(i > 0);
    } catch (err) {
      lastErr = err;
      if (!isAuthNetworkError(err) || i === retries) break;
      await sleep(350 + i * 650);
    }
  }
  throw lastErr;
}

function isHostedSite() {
  const host = window.location.hostname;
  return host.endsWith(".vercel.app") || host.includes("supercompress");
}

function show(el) {
  if (!el) return;
  el.classList.remove("hidden");
}
function hide(el) {
  if (!el) return;
  el.classList.add("hidden");
}
function setError(msg) {
  if (!msg) {
    hide(authError);
    authError.textContent = "";
    return;
  }
  authError.textContent = msg;
  show(authError);
}

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function localStoreKey() {
  if (idToken?.startsWith("dev:")) {
    return `sc_dash_keys_${idToken.split(":")[1] || "dev"}`;
  }
  const uid = currentUser?.uid || currentUser?.email || "default";
  return `sc_dash_keys_${uid}`;
}

function readLocalStore() {
  try {
    return JSON.parse(localStorage.getItem(localStoreKey()) || '{"keys":[],"usage":{}}');
  } catch {
    return { keys: [], usage: {} };
  }
}

function writeLocalStore(data) {
  localStorage.setItem(localStoreKey(), JSON.stringify(data));
}

function makeSecret() {
  const rand = () => crypto.randomUUID().replace(/-/g, "");
  return `sc_live_${rand()}${rand().slice(0, 8)}`;
}

function localApiFetch(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const store = readLocalStore();

  if (path === "/api/keys" && method === "GET") {
    return Promise.resolve({ keys: store.keys, usage: store.usage });
  }

  if (path === "/api/keys" && method === "POST") {
    const body = JSON.parse(opts.body || "{}");
    const secret = makeSecret();
    const id = crypto.randomUUID();
    const rec = {
      id,
      name: body.name || "Production",
      prefix: secret.slice(0, 20),
      created_at: new Date().toISOString(),
      last_used_at: null,
    };
    store.keys.unshift(rec);
    store.usage[id] = {
      total_requests: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_tokens_saved: 0,
    };
    writeLocalStore(store);
    return Promise.resolve({ key: rec, secret });
  }

  const match = path.match(/^\/api\/keys\/([^/]+)$/);
  if (match) {
    const keyId = match[1];
    if (method === "PATCH") {
      const body = JSON.parse(opts.body || "{}");
      const key = store.keys.find((k) => k.id === keyId);
      if (!key) return Promise.reject(new Error("Key not found"));
      key.name = body.name;
      writeLocalStore(store);
      return Promise.resolve({ key });
    }
    if (method === "DELETE") {
      const key = store.keys.find((k) => k.id === keyId);
      if (!key) return Promise.reject(new Error("Key not found"));
      store.keys = store.keys.filter((k) => k.id !== keyId);
      delete store.usage[keyId];
      writeLocalStore(store);
      return Promise.resolve({ key });
    }
  }

  return Promise.reject(new Error(`Unsupported request: ${method} ${path}`));
}

async function detectApiMode() {
  if (isHostedSite()) {
    apiMode = "remote";
    hide($("dash-api-banner"));
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/health`, { method: "GET" });
    if (res.ok) {
      apiMode = "remote";
      hide($("dash-api-banner"));
      return;
    }
  } catch (_) {
    /* static hosting — no API */
  }
  apiMode = "local";
  show($("dash-api-banner"));
}

const FETCH_TIMEOUT = 30000; // 20s timeout for API calls

async function apiFetch(path, opts = {}, retry = true) {
  if (apiMode === "local") return localApiFetch(path, opts);

  await ensureFreshToken(false);
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers, signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await res.json().catch(() => ({}));

    if (res.status === 401 && retry && auth?.currentUser) {
      await ensureFreshToken(true);
      return apiFetch(path, opts, false);
    }

    if (!res.ok) throw new Error(data.detail || res.statusText || `Request failed (HTTP ${res.status})`);
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("Request timed out — server took too long to respond. Try again.");
    }
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadKeysFresh(retries = 6) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const data = await apiFetch(`/api/keys?fresh=1&_=${Date.now()}`);
      keysData = data.keys || [];
      usageData = data.usage || {};
      accountUsage = data.account_usage || null;
      codingAgentUsage = data.coding_agent_usage || {};
      agentPluginLink = data.agent_plugin || { linked: false };
      renderKeys();
      renderUsage();
      renderCodingAgents();
      updateStats();
      renderSnippet("dash");
      return data;
    } catch (err) {
      lastErr = err;
      await sleep(200 + i * 250);
    }
  }
  throw lastErr || new Error("Failed to refresh keys");
}

function renderCodingAgents() {
  const tbody = $("coding-tbody");
  const container = $("coding-stats-container");
  const cta = $("coding-cta");
  const connected = $("coding-connected");
  const connectedMeta = $("coding-connected-meta");
  if (!tbody) return;

  const agents = Object.keys(codingAgentUsage);
  const isLinked = Boolean(agentPluginLink?.linked) || agents.length > 0;

  if (agents.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="dash-empty">${
      isLinked
        ? "Linked — waiting for the first compress from a coding agent."
        : "No coding agent usage yet."
    }</td></tr>`;
    if (container) container.classList.toggle("hidden", !isLinked);
    if (cta) cta.classList.toggle("hidden", isLinked);
    if (connected) connected.classList.toggle("hidden", !isLinked);
    if (connectedMeta && isLinked) {
      const when = agentPluginLink.linked_at ? formatDate(agentPluginLink.linked_at) : "";
      const src = agentPluginLink.source ? String(agentPluginLink.source) : "oauth";
      connectedMeta.textContent = when
        ? `Linked via ${src} · ${when}`
        : `Linked via ${src}`;
    }
    if (isLinked) {
      const n = (v) => formatNum(v);
      if ($("coding-total-agents")) $("coding-total-agents").textContent = "0";
      if ($("coding-total-requests")) $("coding-total-requests").textContent = n(0);
      if ($("coding-total-saved")) $("coding-total-saved").textContent = n(0);
      if ($("coding-total-in")) $("coding-total-in").textContent = n(0);
    }
    return;
  }

  // Show stats, hide install CTA (keep connected banner subtle / hide it when stats exist)
  if (container) container.classList.remove("hidden");
  if (cta) cta.classList.add("hidden");
  if (connected) connected.classList.add("hidden");

  // Update summary
  let totalReqs = 0, totalIn = 0, totalOut = 0, totalSaved = 0;
  for (const agent of Object.values(codingAgentUsage)) {
    totalReqs += agent.requests || 0;
    totalIn += agent.tokens_in || 0;
    totalOut += agent.tokens_out || 0;
    totalSaved += agent.tokens_saved || 0;
  }
  const n = (v) => formatNum(v);
  $("coding-total-agents").textContent = agents.length;
  $("coding-total-requests").textContent = n(totalReqs);
  $("coding-total-saved").textContent = n(totalSaved);
  $("coding-total-in").textContent = n(totalIn);

  // Render table
  tbody.innerHTML = agents
    .sort((a, b) => (codingAgentUsage[b].requests || 0) - (codingAgentUsage[a].requests || 0))
    .map((name) => {
      const a = codingAgentUsage[name];
      const savedPct = a.tokens_in > 0 ? Math.round((a.tokens_saved / a.tokens_in) * 100) : 0;
      const icon = agentIcon(name);
      return `<tr>
        <td><strong>${icon} ${escapeHtml(name)}</strong></td>
        <td>${a.requests || 0}</td>
        <td>${n(a.tokens_in || 0)}</td>
        <td>${n(a.tokens_out || 0)}</td>
        <td>${n(a.tokens_saved || 0)}</td>
        <td>${savedPct}%</td>
        <td>${formatDate(a.last_seen)}</td>
      </tr>`;
    })
    .join("");
}

function agentIcon(name) {
  const key = String(name || "").toLowerCase().replace(/_/g, "-");
  const icons = {
    cursor: "🖱️",
    windsurf: "🏄",
    continue: "▶️",
    cline: "🤖",
    "claude-code": "🧠",
    aider: "🤝",
    copilot: "👻",
    codex: "📝",
    mcp: "🔌",
    "openai-client": "🔵",
    "api-client": "🔌",
  };
  return icons[key] || "⚡";
}

async function loadKeys() {
  try {
    const data = await apiFetch("/api/keys");
    keysData = data.keys || [];
    usageData = data.usage || {};
    accountUsage = data.account_usage || null;
    codingAgentUsage = data.coding_agent_usage || {};
    agentPluginLink = data.agent_plugin || { linked: false };
    renderKeys();
    renderUsage();
    renderCodingAgents();
    updateStats();
    renderSnippet("dash");
    await ensureDefaultKey();
    renderActivationChecklist();
    if (lastBillingSub) renderPaygNudge(lastBillingSub);
  } catch (err) {
    keysGrid.innerHTML = `<p class="dash-empty">Failed to load keys: ${escapeHtml(err.message)}</p>`;
  }
}

async function ensureDefaultKey() {
  if (apiMode !== "remote" || keysData.length > 0 || defaultKeyProvisioning) return;
  defaultKeyProvisioning = true;
  try {
    const data = await apiFetch("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name: "Default" }),
    });
    if (!data?.key || !data?.secret) return;
    lastCreatedSecret = data.secret;
    saveSecret(data.secret);
    keysData = [data.key];
    usageData[data.key.id] = usageData[data.key.id] || {
      total_requests: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_tokens_saved: 0,
    };
    renderKeys();
    renderUsage();
    updateStats();
    renderSnippet("dash");
    $("secret-value").textContent = data.secret;
    renderSnippet("modal");
    show($("modal-secret"));
  } catch (err) {
    console.error("Default API key provisioning failed", err);
  } finally {
    defaultKeyProvisioning = false;
  }
}

function storedSecret() {
  try {
    return sessionStorage.getItem(SECRET_KEY) || "";
  } catch {
    return "";
  }
}

function saveSecret(secret) {
  try {
    if (secret) sessionStorage.setItem(SECRET_KEY, secret);
  } catch {
    /* ignore */
  }
}

async function sendTestRequest() {
  if (!keysData.length) {
    alert("Create an API key first.");
    return;
  }

  let secret = storedSecret();
  if (!secret) {
    secret = prompt("Paste your sc_live_… key to send a test compress request:");
    if (!secret?.trim()) return;
    secret = secret.trim();
    saveSecret(secret);
  }

  const btn = $("btn-test-key");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending…";
  }

  const prefix = secret.slice(0, 16);
  const keyMatch = keysData.find((k) => k.prefix === prefix) || keysData[0];
  const beforeReq = usageData[keyMatch.id]?.total_requests || 0;

  try {
    const res = await fetch(`${apiBaseUrl()}/api/v1/compress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": secret,
      },
      body: JSON.stringify({
        context:
          "def fetch_user(row_id):\n    return None if row_id is missing else User(row_id)\n\n" +
          Array.from({ length: 40 }, (_, i) => `# context line ${i}: agent padding`).join("\n"),
        query: "What does fetch_user return when the row is missing?",
        budget_ratio: 0.35,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || res.statusText || "Request failed");

    await loadKeysFresh(8);

    const afterReq = usageData[keyMatch.id]?.total_requests || 0;
    if (afterReq > beforeReq) {
      alert(`Test OK — ${data.kept_tokens}/${data.original_tokens} tokens kept. Usage updated (${afterReq} requests).`);
    } else {
      alert(`Test OK — ${data.kept_tokens}/${data.original_tokens} tokens kept. Usage may take a moment; try Refresh usage.`);
    }
  } catch (err) {
    alert(err.message || "Test request failed");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send test request";
    }
  }
}

async function showDashboard(user) {
  // Transition to dashboard view FIRST (synchronous, before any async calls)
  hide(viewAuth);
  show(viewDash);
  show($("dash-profile"));
  setNavCtaLoggedIn(true);
  const name = user.displayName || user.email?.split("@")[0] || "User";
  const nameEl = $("dash-profile-name");
  if (nameEl) nameEl.textContent = name;
  const emailEl = $("dash-profile-email");
  if (emailEl) emailEl.textContent = user.email || "";
  const initialEl = $("dash-profile-initial");
  if (initialEl) initialEl.textContent = name.charAt(0).toUpperCase();
  window.scrollTo(0, 0);
  // Async data loading — errors are caught per-function, won't break dashboard
  try {
    await detectApiMode();
  } catch (_) {}
  try {
    await loadKeys();
  } catch (_) {}
  try {
    renderSnippet("dash");
  } catch (_) {}
  try {
    await loadSubscription();
  } catch (_) {}
}

function showAuth() {
  show(viewAuth);
  hide(viewDash);
  hide($("dash-profile"));
  setNavCtaLoggedIn(false);
}

function setNavCtaLoggedIn(loggedIn) {
  for (const id of ["dash-nav-cta", "dash-nav-cta-mobile", "dash-nav-cta-drawer", "dash-nav-login-drawer"]) {
    const el = $(id);
    if (!el) continue;
    el.classList.toggle("hidden", Boolean(loggedIn));
  }
}

function cleanAuthQuery() {
  if (!window.history?.replaceState) return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of ["signup", "mode", "connect"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) {
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, "", next || "/dashboard");
  }
}

function connectCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return (params.get("connect") || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function completeDeviceConnect(code) {
  const cleanCode = String(code || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!cleanCode || cleanCode.length < 6) return null;
  const params = new URLSearchParams(window.location.search);
  const source = (params.get("source") || "oauth").trim().slice(0, 40) || "oauth";
  const res = await apiFetch("/api/connect-device", {
    method: "POST",
    body: JSON.stringify({ code: cleanCode, source }),
  });
  if (res?.secret) {
    lastCreatedSecret = res.secret;
    saveSecret(res.secret);
  }
  if (res?.agent_plugin?.linked) {
    agentPluginLink = res.agent_plugin;
  } else {
    agentPluginLink = { linked: true, source, linked_at: new Date().toISOString() };
  }
  cleanAuthQuery();
  return res;
}

async function triggerWelcomeEmail(user, { isNewUser = false } = {}) {
  if (!user?.email || !idToken) return;
  try {
    await apiFetch("/api/account?op=welcome", {
      method: "POST",
      body: JSON.stringify({
        is_new_user: Boolean(isNewUser),
        email: user.email || "",
        display_name: user.displayName || "",
        creation_time: user.metadata?.creationTime || null,
        source: isNewUser ? "signup" : "dashboard_login",
      }),
    });
  } catch (err) {
    console.warn("Welcome email trigger failed", err);
  }
}

async function enterDashboard(user, { isNewUser = false } = {}) {
  authResolved = true;
  idToken = await getUserToken(user);
  currentUser = user;
  saveSession({
    mode: "firebase",
    uid: user.uid,
    email: user.email || "",
    displayName: user.displayName || user.email?.split("@")[0] || "User",
  });
  const connectCode = connectCodeFromUrl();
  if (connectCode) {
    try {
      await completeDeviceConnect(connectCode);
    } catch (err) {
      console.warn("Device connect failed", err);
      setError(err.message || "Account connection failed");
    }
  }
  cleanAuthQuery();
  setError("");
  // Fire-and-forget founder welcome for new signups (deduped server-side).
  void triggerWelcomeEmail(user, { isNewUser });
  await showDashboard(user);
}

/* ── Billing / Plans ── */

async function loadSubscription() {
  const statusCard = $("billing-status-card");
  if (!statusCard) return;

  try {
    const sub = await apiFetch("/api/billing");
    lastBillingSub = sub;
    renderSubscription(sub);
    renderPaygNudge(sub);
    renderActivationChecklist();
  } catch (err) {
    statusCard.innerHTML = `<p class="dash-empty" style="padding:20px">Could not load billing info: ${escapeHtml(err.message)}</p>`;
  }
}

function totalTokensIn() {
  let tokens = 0;
  for (const snap of Object.values(usageData || {})) {
    tokens += snap.total_tokens_in || 0;
  }
  return tokens;
}

function totalRequests() {
  let reqs = 0;
  for (const snap of Object.values(usageData || {})) {
    reqs += snap.total_requests || 0;
  }
  return reqs;
}

function renderPaygNudge(sub) {
  const banner = $("dash-payg-banner");
  if (!banner) return;
  const payg = !!(sub?.payg_enabled || sub?.unlimited || (sub?.plan && sub.plan !== "free"));
  const limitHit = !!(sub?.limit_reached || sub?.paywall || (sub?.free_tokens_remaining === 0 && !payg));

  if (payg && !limitHit) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }

  const freeCap = sub.free_tokens_per_month || sub.tokens_per_month || 1_000_000;
  const used = sub.tokens_used_this_period || totalTokensIn() || 0;
  const pct = freeCap > 0 ? Math.min(100, (Math.min(used, freeCap) / freeCap) * 100) : 0;
  const hasUse = used > 0 || totalRequests() > 0;

  let tone = "";
  let title = "Never hard-stop.";
  let copy = "";
  let cta = "Add credits";

  if (limitHit) {
    tone = "dash-payg-banner--blocked";
    title = "Compression paused — free 1M used";
    copy =
      `You've hit your free ${formatNum(freeCap)} tokens this month (${formatNum(used)} used). ` +
      `Add credits to unlock again — $0.30 per 1M tokens after free.`;
    cta = "Add credits";
  } else if (pct >= 80) {
    tone = "dash-payg-banner--urgent";
    copy = `You've used ${Math.round(pct)}% of your free 1M tokens. Add credits now so compression never hard-stops — $0.30/1M after free.`;
  } else if (pct >= 50) {
    tone = "dash-payg-banner--warn";
    copy = `Halfway through your free 1M this month. Add credits so a busy agent week doesn't cut you off.`;
  } else if (hasUse) {
    tone = "";
    copy =
      "Nice — first compress landed. Add credits so compression never hard-stops. You still get 1M free, then $0.30/1M.";
  } else {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }

  banner.className = `dash-payg-banner ${tone}`.trim();
  banner.innerHTML = `
    <div class="dash-payg-banner-copy">
      <p><strong>${escapeHtml(title)}</strong> ${escapeHtml(copy)}</p>
      ${limitHit ? `<p class="dash-payg-banner-price">$0.30 / 1M after free · load credits anytime</p>` : ""}
    </div>
    <button type="button" class="btn-brand dash-payg-banner-cta" id="btn-payg-nudge">${escapeHtml(cta)}</button>
  `;
  $("btn-payg-nudge")?.addEventListener("click", () => {
    // Jump to billing panel then open Stripe
    document.querySelector('.dash-topnav-item[data-panel="billing"]')?.click();
    handleEnablePayg();
  });

  if (limitHit) {
    // Force billing panel into view once per session so the wall is obvious
    try {
      if (!sessionStorage.getItem("sc_paywall_shown")) {
        sessionStorage.setItem("sc_paywall_shown", "1");
        document.querySelector('.dash-topnav-item[data-panel="billing"]')?.click();
      }
    } catch (_) { /* ignore */ }
  }
}

function renderActivationChecklist() {
  /* Activation checklist removed from dashboard UI. */
}

function renderSubscription(sub) {
  const statusCard = $("billing-status-card");
  if (!statusCard) return;
  lastBillingSub = sub;

  const freeCap = sub.free_tokens_per_month || sub.tokens_per_month || 1_000_000;
  const used = sub.tokens_used_this_period || 0;
  const freeUsed = Math.min(used, freeCap);
  const pct = Math.min(100, Math.round((freeUsed / freeCap) * 10000) / 100);
  const fillClass = pct >= 90 ? "dash-billing-usage-fill--full" : pct >= 70 ? "dash-billing-usage-fill--high" : "";
  const payg = !!(sub.payg_enabled || sub.unlimited || (sub.plan && sub.plan !== "free"));
  const creditWallet = !!(sub.credit_wallet || (payg && sub.credit_balance_usd != null));
  const creditBalance = Number(sub.credit_balance_usd);
  const hasCreditBalance = Number.isFinite(creditBalance);
  const limitHit = !!(sub.limit_reached || sub.paywall) && !payg;
  const overageUsd = Number(sub.estimated_overage_usd || 0);
  const billable = sub.billable_tokens || Math.max(0, used - freeCap);

  const title = payg || creditWallet
    ? "Pay as you go"
    : limitHit
      ? "Paused — free allowance used"
      : "Free allowance";
  const badge = payg || creditWallet
    ? (sub.cancel_at_period_end ? "cancels at period end" : (sub.status || "active"))
    : limitHit
      ? "LOCKED"
      : "free";

  statusCard.innerHTML = `
    ${limitHit ? `
      <div class="dash-paywall-lock" role="alert">
        <div class="dash-paywall-lock-kicker">Paywall</div>
        <h2>Compression is paused</h2>
        <p>You used your free <strong>${formatNum(freeCap)}</strong> tokens this month (<strong>${formatNum(used)}</strong> in). Add credits to unlock — <strong>$0.30 / 1M</strong> after free.</p>
        <button type="button" class="btn-brand dash-paywall-lock-cta" id="btn-paywall-unlock">Add credits</button>
      </div>
    ` : ""}
    <div class="dash-billing-status-active">
      <div class="dash-billing-status-info">
        <h2>${escapeHtml(title)}</h2>
        <p>
          <span class="dash-billing-status-badge${limitHit ? " dash-billing-status-badge--locked" : ""}">${escapeHtml(badge)}</span>
          ${hasCreditBalance
            ? `<span style="margin-left:8px;font-size:13px;color:var(--text-body)">Credit balance <strong>$${creditBalance.toFixed(2)}</strong></span>`
            : payg && sub.has_active_subscription
              ? `<span style="margin-left:8px;font-size:13px;color:var(--text-body)">Period ends ${formatDate(sub.period_end)}</span>`
              : `<span style="margin-left:8px;font-size:13px;color:var(--text-body)">$1 free / 1M tokens each month</span>`
          }
        </p>
      </div>
      <div class="dash-billing-status-actions">
        ${payg || creditWallet
          ? `
            <button type="button" class="btn-brand" id="btn-enable-payg-top">Add credits</button>
            <button type="button" class="btn-brand" id="btn-manage-billing" style="background:var(--text-muted)">Manage billing</button>
            ${sub.cancel_at_period_end
              ? `<button type="button" class="btn-brand" id="btn-reactivate-billing" style="background:#059669">Reactivate</button>`
              : `<button type="button" class="btn-brand" id="btn-cancel-billing" style="background:var(--text-muted)">Disable PAYG</button>`
            }
          `
          : `<button type="button" class="btn-brand" id="btn-enable-payg-top">${limitHit ? "Unlock — add credits" : "Add credits"}</button>`
        }
      </div>
    </div>
    <div class="dash-billing-usage-bar-wrap">
      <div class="dash-billing-usage-bar-label">
        <span><strong>${formatNum(freeUsed)}</strong> / ${formatNum(freeCap)} free tokens used</span>
        <span>${pct}%</span>
      </div>
      <div class="dash-billing-usage-track">
        <div class="dash-billing-usage-fill ${fillClass}" style="width:${pct}%"></div>
      </div>
    </div>
    ${creditWallet || hasCreditBalance
      ? `<p style="margin:12px 0 0;font-size:13px;color:var(--text-body)">Prepaid wallet at $0.30 / 1M after free. Load $${Number(sub.min_credit_limit_usd || 10)}+ (about ${Math.round(Number(sub.min_credit_limit_usd || 10) / Number(sub.usd_per_million || 0.3))}M+ tokens).</p>`
      : payg && billable > 0
      ? `<p style="margin:12px 0 0;font-size:13px;color:var(--text-body)">Overage this month: <strong>${formatNum(billable)}</strong> tokens (~$${overageUsd.toFixed(2)} estimated)</p>`
      : payg
        ? `<p style="margin:12px 0 0;font-size:13px;color:var(--text-body)">No overage yet. Usage beyond 1M bills at $0.30 / 1M tokens.</p>`
        : pct >= 100
          ? `<p style="margin:12px 0 0;font-size:14px;color:#b91c1c;font-weight:600">Free allowance used. Add credits to keep compressing.</p>`
          : ""
    }
  `;

  $("btn-paywall-unlock")?.addEventListener("click", () => handleEnablePayg());
  // Update plan cards
  document.querySelectorAll(".dash-plan-card").forEach((card) => {
    const plan = card.dataset.plan;
    const isFreeCard = plan === "free";
    const isPaygCard = plan === "payg";
    card.classList.toggle("dash-plan-card--current", isFreeCard ? !payg : payg);
    const cta = card.querySelector(".dash-plan-cta");
    if (!cta) return;

    if (isFreeCard) {
      cta.innerHTML = `<span class="dash-plan-current-label">${payg ? "Still included" : "Current"}</span>`;
    } else if (isPaygCard) {
      cta.innerHTML = `<button type="button" class="dash-plan-btn btn-brand" data-plan-btn="payg">Add credits</button>`;
    }
  });

  document.querySelectorAll("[data-plan-btn]").forEach((btn) => {
    btn.addEventListener("click", () => handleEnablePayg());
  });

  const enableTop = $("btn-enable-payg-top");
  if (enableTop) enableTop.addEventListener("click", handleEnablePayg);

  const manageBtn = $("btn-manage-billing");
  if (manageBtn) manageBtn.addEventListener("click", handleManageBilling);

  const cancelBtn = $("btn-cancel-billing");
  if (cancelBtn) cancelBtn.addEventListener("click", handleCancelSubscription);

  const reactivateBtn = $("btn-reactivate-billing");
  if (reactivateBtn) reactivateBtn.addEventListener("click", handleReactivateSubscription);
}

function creditLimitsFromSub(sub) {
  const min = Number(sub?.min_credit_limit_usd);
  const max = Number(sub?.max_credit_limit_usd);
  const def = Number(sub?.default_credit_limit_usd);
  const rate = Number(sub?.usd_per_million);
  return {
    min: Number.isFinite(min) && min > 0 ? min : 10,
    max: Number.isFinite(max) && max > 0 ? max : 1000,
    def: Number.isFinite(def) && def > 0 ? def : 10,
    rate: Number.isFinite(rate) && rate > 0 ? rate : 0.3,
  };
}

function syncCreditsHint() {
  const input = $("credits-amount");
  const hint = $("credits-hint");
  if (!input || !hint) return;
  const { min, max, rate } = creditLimitsFromSub(lastBillingSub);
  const raw = Number(input.value);
  const amount = Number.isFinite(raw) ? raw : 0;
  const tokensM = rate > 0 ? Math.round((amount / rate) * 10) / 10 : 0;
  const tokensLabel = Number.isFinite(amount) && amount > 0
    ? `About ${tokensM}M tokens after free`
    : "Enter an amount";
  hint.textContent = `${tokensLabel} · $${rate}/1M`;
}

function syncCreditsPresets(amount) {
  document.querySelectorAll(".dash-credits-preset").forEach((btn) => {
    const preset = Number(btn.dataset.amount);
    btn.classList.toggle("active", Number.isFinite(amount) && preset === amount);
  });
}

function openCreditsModal() {
  const modal = $("modal-credits");
  if (!modal) {
    // Modal missing: still default auto-recharge ON when jumping straight to checkout
    handleEnablePaygCheckout(lastBillingSub?.default_credit_limit_usd || 10, true);
    return;
  }
  const { min, max, def, rate } = creditLimitsFromSub(lastBillingSub);
  const input = $("credits-amount");
  const err = $("credits-error");
  const title = $("credits-modal-title");
  const lead = $("credits-modal-lead");
  const payg = !!(lastBillingSub?.payg_enabled || lastBillingSub?.credit_wallet);
  const balance = Number(lastBillingSub?.credit_balance_usd || 0);

  if (title) title.textContent = payg ? "Add credits" : "Unlock with credits";
  if (lead) {
    lead.textContent = payg
      ? `Balance $${balance.toFixed(2)}. $0.30 = 1M tokens after free. $10 ≈ ${Math.round(10 / rate)}M tokens.`
      : `$0.30 = 1M tokens after your free monthly allowance. $10 ≈ ${Math.round(10 / rate)}M tokens.`;
  }
  if (input) {
    input.min = String(min);
    input.max = String(max);
    const preferred = Number(lastBillingSub?.credit_limit_usd);
    input.value = String(Number.isFinite(preferred) && preferred >= min ? preferred : def);
  }
  if (err) {
    err.textContent = "";
    err.classList.add("hidden");
  }
  const auto = $("credits-auto-recharge");
  if (auto) {
    // Default ON when adding / topping up credits (user can uncheck).
    // If they previously enabled auto-recharge, keep it on; never open with it forced off.
    auto.checked = true;
  }
  syncCreditsPresets(Number(input?.value));
  syncCreditsHint();
  modal.classList.remove("hidden");
  input?.focus();
  input?.select();
}

function closeCreditsModal() {
  $("modal-credits")?.classList.add("hidden");
}

function initCreditsModal() {
  const modal = $("modal-credits");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  document.querySelectorAll(".dash-credits-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const amount = Number(btn.dataset.amount);
      const input = $("credits-amount");
      if (input && Number.isFinite(amount)) {
        input.value = String(amount);
        syncCreditsPresets(amount);
        syncCreditsHint();
      }
    });
  });

  $("credits-amount")?.addEventListener("input", () => {
    syncCreditsPresets(Number($("credits-amount")?.value));
    syncCreditsHint();
  });

  $("btn-cancel-credits")?.addEventListener("click", closeCreditsModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeCreditsModal();
  });

  $("btn-confirm-credits")?.addEventListener("click", async () => {
    const { min, max } = creditLimitsFromSub(lastBillingSub);
    const raw = Number($("credits-amount")?.value);
    const err = $("credits-error");
    if (!Number.isFinite(raw) || raw < min || raw > max) {
      if (err) {
        err.textContent = `Enter an amount between $${min} and $${max}.`;
        err.classList.remove("hidden");
      }
      return;
    }
    const amount = Math.round(raw * 100) / 100;
    const autoRecharge = Boolean($("credits-auto-recharge")?.checked);
    const submit = $("btn-confirm-credits");
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Opening checkout…";
    }
    try {
      await handleEnablePaygCheckout(amount, autoRecharge);
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Continue to checkout";
      }
    }
  });
}

function handleEnablePayg() {
  openCreditsModal();
}

async function handleEnablePaygCheckout(creditUsd, autoRecharge = true) {
  if (apiMode === "local") {
    alert("Stripe billing is not available in local/dev mode. Set up production with STRIPE_SECRET_KEY on Vercel.");
    return;
  }

  const { min, max } = creditLimitsFromSub(lastBillingSub);
  const amount = Math.round(Number(creditUsd) * 100) / 100;
  if (!Number.isFinite(amount) || amount < min || amount > max) {
    alert(`Enter an amount between $${min} and $${max}.`);
    return;
  }

  const alreadyPayg = !!(lastBillingSub?.payg_enabled || lastBillingSub?.credit_wallet);
  const action = alreadyPayg ? "top_up" : "enable_payg";

  try {
    const data = await apiFetch("/api/billing", {
      method: "POST",
      body: JSON.stringify({
        action,
        credit_limit_usd: amount,
        auto_recharge: autoRecharge,
        force_topup: alreadyPayg,
      }),
    });

    if (data.url) {
      window.location.href = data.url;
    }
  } catch (err) {
    const box = $("credits-error");
    if (box) {
      box.textContent = err.message || "Failed to start checkout";
      box.classList.remove("hidden");
    } else {
      alert(err.message || "Failed to start checkout");
    }
  }
}

async function handleManageBilling() {
  try {
    const data = await apiFetch("/api/billing", {
      method: "POST",
      body: JSON.stringify({ action: "portal" }),
    });
    if (data.url) {
      window.location.href = data.url;
    }
  } catch (err) {
    alert(err.message || "Failed to open billing portal");
  }
}

async function handleCancelSubscription() {
  if (!confirm("Disable pay-as-you-go? You'll keep access until the end of the current billing period, then return to the free 1M token allowance.")) {
    return;
  }
  try {
    const data = await apiFetch("/api/billing", {
      method: "POST",
      body: JSON.stringify({ action: "cancel" }),
    });
    alert(data.message);
    await loadSubscription();
  } catch (err) {
    alert(err.message || "Failed to cancel subscription");
  }
}

async function handleReactivateSubscription() {
  try {
    const data = await apiFetch("/api/billing", {
      method: "POST",
      body: JSON.stringify({ action: "reactivate" }),
    });
    alert(data.message);
    await loadSubscription();
  } catch (err) {
    alert(err.message || "Failed to reactivate subscription");
  }
}

function formatMoneyUsd(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return "$0";
  return `$${v.toFixed(v >= 1 ? 2 : 2)}`;
}

function launchPayConfetti(durationMs = 3200) {
  const canvas = document.createElement("canvas");
  canvas.id = "sc-pay-confetti";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "9999",
  });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);
  const colors = ["#0566ff", "#0055df", "#7eb6ff", "#171717", "#f4c542", "#e85d4c"];
  const pieces = Array.from({ length: 140 }, () => ({
    x: Math.random() * window.innerWidth,
    y: -20 - Math.random() * window.innerHeight * 0.4,
    w: 6 + Math.random() * 8,
    h: 8 + Math.random() * 10,
    vx: -2 + Math.random() * 4,
    vy: 2 + Math.random() * 5,
    rot: Math.random() * Math.PI,
    vr: -0.2 + Math.random() * 0.4,
    color: colors[(Math.random() * colors.length) | 0],
  }));
  const started = performance.now();
  let raf = 0;
  const tick = (now) => {
    const t = now - started;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < durationMs) {
      raf = requestAnimationFrame(tick);
    } else {
      window.removeEventListener("resize", resize);
      canvas.remove();
    }
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    canvas.remove();
  };
}

function showPaySuccessCelebration({ bonusTokens = 0, bonusUsd = 0, creditedUsd = 0 } = {}) {
  launchPayConfetti();
  let modal = document.getElementById("modal-pay-success");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "modal-pay-success";
    modal.className = "dash-modal";
    modal.innerHTML = `
      <div class="dash-modal-card" role="dialog" aria-modal="true" aria-labelledby="pay-success-title">
        <h2 id="pay-success-title">Congratulations!</h2>
        <p id="pay-success-body" class="dash-modal-lead"></p>
        <p id="pay-success-bonus" class="dash-modal-bonus" hidden></p>
        <button type="button" class="btn-brand" id="pay-success-dismiss">Nice</button>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector("#pay-success-dismiss")?.addEventListener("click", () => {
      modal.classList.add("hidden");
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });
  }
  const body = modal.querySelector("#pay-success-body");
  const bonusEl = modal.querySelector("#pay-success-bonus");
  if (body) {
    body.textContent = creditedUsd
      ? `You're officially on pay-as-you-go. ${formatMoneyUsd(creditedUsd)} in credits just landed.`
      : "You're officially on pay-as-you-go. Welcome aboard.";
  }
  if (bonusEl) {
    if (bonusTokens > 0) {
      bonusEl.hidden = false;
      bonusEl.textContent = `As a thank you, we added 1M tokens on the house (${formatMoneyUsd(bonusUsd || 0.3)}).`;
    } else {
      bonusEl.hidden = true;
    }
  }
  modal.classList.remove("hidden");
}

function initBilling() {
  initCreditsModal();
  // Check URL params for billing success/cancel
  const params = new URLSearchParams(window.location.search);
  if (params.get("billing") === "success") {
    const sessionId = params.get("session_id") || "";
    // Switch to billing panel on next render
    setTimeout(() => {
      const btn = document.querySelector('.dash-topnav-item[data-panel="billing"]');
      if (btn) btn.click();
    }, 500);
    // Webhook fallback: apply credits from Checkout session if Stripe delivery failed
    const celebrate = (data) => {
      showPaySuccessCelebration({
        creditedUsd: Number(data?.credited_usd || 0),
        bonusUsd: Number(data?.first_pay_bonus_usd || 0),
        bonusTokens: Number(data?.first_pay_bonus_tokens || 0),
      });
    };
    if (sessionId.startsWith("cs_")) {
      apiFetch("/api/billing", {
        method: "POST",
        body: JSON.stringify({ action: "reconcile_checkout", session_id: sessionId }),
      })
        .then((data) => {
          celebrate(data || {});
          return loadSubscription();
        })
        .catch((err) => {
          console.warn("Checkout reconcile:", err?.message || err);
          showPaySuccessCelebration({});
        });
    } else {
      showPaySuccessCelebration({});
      setTimeout(() => loadSubscription(), 800);
    }
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

function updateStats() {
  $("stat-keys").textContent = keysData.length;
  const totals = usageTotals();
  const cutPct = totals.tin > 0 ? Math.round((totals.saved / totals.tin) * 100) : null;
  $("stat-requests").textContent = formatNum(totals.reqs);
  $("stat-saved").textContent = formatNum(totals.saved);
  const cutEl = $("stat-cut");
  if (cutEl) cutEl.textContent = cutPct == null ? "—" : `${cutPct}%`;
  const inEl = $("stat-in");
  if (inEl) inEl.textContent = `${formatNum(totals.tin)} in`;
  renderAnalytics();
  renderActivationChecklist();
  if (lastBillingSub) renderPaygNudge(lastBillingSub);
}

/**
 * Month totals for KPIs.
 * Auth `sc_usage` (accountUsage) is the billing source of truth — per-key store
 * can lag or under-count when store writes flake, so never prefer a smaller
 * key-sum over the account meter.
 */
function usageTotals() {
  let keyReqs = 0;
  let keySaved = 0;
  let keyTin = 0;
  let keyTout = 0;
  for (const snap of Object.values(usageData || {})) {
    keyReqs += snap.total_requests || 0;
    keySaved += snap.total_tokens_saved || 0;
    keyTin += snap.total_tokens_in || 0;
    keyTout += snap.total_tokens_out || 0;
  }

  const acctTin = accountUsage?.tokens_in || 0;
  const acctReqs = accountUsage?.requests || 0;
  const acctSaved = accountUsage?.tokens_saved || 0;
  const acctTout = accountUsage?.tokens_out || 0;

  // Prefer account meter whenever it has traffic (matches Billing / PAYG).
  if (acctTin > 0 || acctReqs > 0) {
    return {
      reqs: acctReqs || keyReqs,
      saved: acctSaved,
      tin: acctTin,
      tout: acctTout,
      fromAccount: true,
      keyReqs,
      keyTin,
      keySaved,
      keyTout,
    };
  }

  return {
    reqs: keyReqs,
    saved: keySaved,
    tin: keyTin,
    tout: keyTout,
    fromAccount: false,
    keyReqs,
    keyTin,
    keySaved,
    keyTout,
  };
}

function cutPercent(saved, tin) {
  if (!tin || tin <= 0) return null;
  return Math.round((Number(saved) / Number(tin)) * 100);
}

function setText(id, v) {
  const el = $(id);
  if (el) el.textContent = v;
}

function renderKeysSummary() {
  const totals = usageTotals();
  const cut = cutPercent(totals.saved, totals.tin);
  const n = keysData.length;
  setText("keys-kpi-count", String(n));
  setText("keys-kpi-count-sub", n === 1 ? "active key" : "active keys");
  setText("keys-kpi-input", formatNum(totals.tin));
  setText(
    "keys-kpi-input-sub",
    totals.tin
      ? totals.fromAccount
        ? "this month · all compress traffic"
        : "tokens compressed in"
      : "no traffic yet"
  );
  setText("keys-kpi-saved", formatNum(totals.saved));
  setText(
    "keys-kpi-saved-sub",
    totals.fromAccount ? "this month · billing meter" : "this month"
  );
  setText("keys-kpi-pct", cut == null ? "—" : `${cut}%`);
  setText(
    "keys-kpi-pct-sub",
    totals.tin > 0 ? `${formatNum(totals.saved)} of ${formatNum(totals.tin)}` : "percentage cut"
  );
}

/** KPI cards on API keys panel (charts live only in local/analytics-preview.html). */
function renderAnalytics() {
  renderKeysSummary();
}

function renderKeys() {
  renderKeysSummary();
  if (!keysData.length) {
    keysGrid.innerHTML = `<div class="dash-empty"><strong>No API keys yet.</strong><br/>Click <em>Create key</em> above to get your <code>sc_live_…</code> key.</div>`;
    return;
  }
  keysGrid.innerHTML = keysData
    .map((k) => {
      const snap = usageData[k.id] || {};
      return `
        <article class="dash-key-card" data-id="${k.id}">
          <div class="dash-key-card-body">
            <h3 class="dash-key-card-name">${escapeHtml(k.name)}</h3>
            <code class="dash-key-card-prefix">${escapeHtml(k.prefix)}…</code>
            <p class="dash-key-card-meta">
              Created ${formatDate(k.created_at)}<br/>
              ${snap.total_requests ? `${snap.total_requests} requests · ${formatNum(snap.total_tokens_saved)} tokens saved` : "No usage yet"}
              ${k.last_used_at ? `<br/>Last used ${formatDate(k.last_used_at)}` : ""}
            </p>
          </div>
          <div class="dash-key-card-actions">
            <button type="button" class="btn-link-muted btn-rename" data-id="${k.id}">Rename</button>
            <button type="button" class="btn-link-muted btn-revoke dash-revoke" data-id="${k.id}">Revoke</button>
          </div>
        </article>`;
    })
    .join("");

  keysGrid.querySelectorAll(".btn-rename").forEach((btn) => {
    btn.addEventListener("click", () => openRename(btn.dataset.id));
  });
  keysGrid.querySelectorAll(".btn-revoke").forEach((btn) => {
    btn.addEventListener("click", () => revokeKey(btn.dataset.id));
  });
}

function renderUsage() {
  if (!keysData.length && !(accountUsage && (accountUsage.tokens_in || accountUsage.requests || accountUsage.tokens_saved))) {
    usageTbody.innerHTML = `<tr><td colspan="7" class="dash-empty">No usage yet.</td></tr>`;
    renderAnalytics();
    return;
  }

  const rows = [];
  // Always show per-key rows when keys exist. Account total only when meter is ahead.
  const totals = usageTotals();
  const keyTin = totals.keyTin || 0;
  const keyReqs = totals.keyReqs || 0;
  const keySaved = totals.keySaved || 0;
  const keyTout = totals.keyTout || 0;
  const acctTin = accountUsage?.tokens_in || 0;
  const acctReqs = accountUsage?.requests || 0;
  const acctSaved = accountUsage?.tokens_saved || 0;
  const acctTout = accountUsage?.tokens_out || 0;

  if (accountUsage && (acctTin > 0 || acctReqs > 0 || acctSaved > 0) && acctTin > keyTin + 500) {
    const cut = cutPercent(acctSaved, acctTin);
    const cutHtml =
      cut == null
        ? `<span class="dash-cut-pill dash-cut-pill--muted">—</span>`
        : `<span class="dash-cut-pill">${cut}%</span>`;
    rows.push(`
        <tr>
          <td><strong>Account total (this month)</strong><br/><span class="dash-empty">billing meter · ${formatNum(keyTin)} attributed to keys</span></td>
          <td>${acctReqs || 0}</td>
          <td>${formatNum(acctTin)}</td>
          <td>${formatNum(acctTout)}</td>
          <td>${formatNum(acctSaved)}</td>
          <td>${cutHtml}</td>
          <td>—</td>
        </tr>`);
  }

  for (const k of keysData) {
    const snap = usageData[k.id] || {};
    const tin = snap.total_tokens_in || 0;
    const saved = snap.total_tokens_saved || 0;
    const reqs = snap.total_requests || 0;
    const cut = cutPercent(saved, tin);
    const cutHtml =
      cut == null
        ? `<span class="dash-cut-pill dash-cut-pill--muted">—</span>`
        : `<span class="dash-cut-pill">${cut}%</span>`;
    rows.push(`
        <tr>
          <td><strong>${escapeHtml(k.name)}</strong><br/><code>${escapeHtml(k.prefix)}…</code></td>
          <td>${reqs}</td>
          <td>${formatNum(tin)}</td>
          <td>${formatNum(snap.total_tokens_out || 0)}</td>
          <td>${formatNum(saved)}</td>
          <td>${cutHtml}</td>
          <td>${formatDate(k.last_used_at)}</td>
        </tr>`);
  }

  // If account meter is ahead of per-key store, show the unallocated gap explicitly.
  if (acctTin > keyTin + 100 || acctReqs > keyReqs) {
    const gapIn = Math.max(0, acctTin - keyTin);
    const gapSaved = Math.max(0, acctSaved - keySaved);
    const gapOut = Math.max(0, acctTout - keyTout);
    const gapReqs = Math.max(0, acctReqs - keyReqs);
    const cut = cutPercent(gapSaved, gapIn);
    const cutHtml =
      cut == null
        ? `<span class="dash-cut-pill dash-cut-pill--muted">—</span>`
        : `<span class="dash-cut-pill">${cut}%</span>`;
    rows.push(`
        <tr>
          <td><strong>Unallocated</strong><br/><span class="dash-empty">metered but not yet in per-key store</span></td>
          <td>${gapReqs}</td>
          <td>${formatNum(gapIn)}</td>
          <td>${formatNum(gapOut)}</td>
          <td>${formatNum(gapSaved)}</td>
          <td>${cutHtml}</td>
          <td>—</td>
        </tr>`);
  }

  if (!rows.length) {
    usageTbody.innerHTML = `<tr><td colspan="7" class="dash-empty">No usage yet.</td></tr>`;
  } else {
    usageTbody.innerHTML = rows.join("");
  }
  renderAnalytics();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function openRename(keyId) {
  renameKeyId = keyId;
  const key = keysData.find((k) => k.id === keyId);
  $("rename-input").value = key?.name || "";
  show($("modal-rename"));
}

async function confirmRename() {
  if (!renameKeyId) return;
  const name = $("rename-input").value.trim();
  if (!name) return;
  try {
    await apiFetch(`/api/keys/${renameKeyId}`, { method: "PATCH", body: JSON.stringify({ name }) });
    hide($("modal-rename"));
    renameKeyId = null;
    await loadKeys();
  } catch (err) {
    alert(err.message);
  }
}

async function revokeKey(keyId) {
  const key = keysData.find((k) => k.id === keyId);
  if (!confirm(`Revoke "${key?.name}"? This cannot be undone.`)) return;
  try {
    await apiFetch(`/api/keys/${keyId}`, { method: "DELETE" });
    await loadKeys();
  } catch (err) {
    alert(err.message);
  }
}

async function createKey() {
  const name = $("key-name").value.trim() || "Production";
  try {
    const data = await apiFetch("/api/keys", { method: "POST", body: JSON.stringify({ name }) });
    hide($("modal-create"));
    $("key-name").value = "";
    $("secret-value").textContent = data.secret;
    lastCreatedSecret = data.secret;
    saveSecret(data.secret);
    modalSnippetTab = "python";
    document.querySelectorAll("#modal-secret .dash-snippet-tab").forEach((b, i) => {
      b.classList.toggle("active", i === 0);
    });
    renderSnippet("modal");
    show($("modal-secret"));
    if (data.key) {
      keysData = [data.key, ...keysData.filter((k) => k.id !== data.key.id)];
      usageData[data.key.id] = usageData[data.key.id] || {
        total_requests: 0,
        total_tokens_in: 0,
        total_tokens_out: 0,
        total_tokens_saved: 0,
      };
      renderKeys();
      renderUsage();
      updateStats();
    }
    await loadKeys();
  } catch (err) {
    alert(err.message);
  }
}

function initPanels() {
  document.querySelectorAll(".dash-topnav-item[data-panel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".dash-topnav-item[data-panel]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const panel = btn.dataset.panel;
      document.querySelectorAll("[id^='panel-']").forEach((p) => p.classList.add("hidden"));
      const panelEl = $(`panel-${panel}`);
      if (panelEl) panelEl.classList.remove("hidden");
      if (panel === "billing") loadSubscription();
      if (panel === "keys") {
        requestAnimationFrame(() => renderKeysSummary());
      }
    });
  });
}

function initModals() {
  const modalEls = ["btn-create-key","btn-cancel-create","btn-confirm-create","btn-close-secret","btn-copy-secret","btn-cancel-rename","btn-confirm-rename"];
  for (const id of modalEls) {
    if (!$("modal-"+id) && id.startsWith("modal-")) continue;
    if (!$(id)) console.warn("Dashboard: missing element #"+id);
  }
  $("btn-create-key")?.addEventListener("click", () => show($("modal-create")));
  $("btn-cancel-create")?.addEventListener("click", () => hide($("modal-create")));
  $("btn-confirm-create")?.addEventListener("click", createKey);
  $("btn-close-secret")?.addEventListener("click", () => hide($("modal-secret")));
  $("btn-copy-secret")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText($("secret-value").textContent);
    $("btn-copy-secret").textContent = "Copied!";
    setTimeout(() => ($("btn-copy-secret").textContent = "Copy key"), 2000);
  });
  $("btn-cancel-rename")?.addEventListener("click", () => hide($("modal-rename")));
  $("btn-confirm-rename")?.addEventListener("click", confirmRename);
  $("btn-test-key")?.addEventListener("click", sendTestRequest);

  const refreshAgents = async () => {
    try {
      await loadKeysFresh(3);
    } catch (err) {
      setError(err.message || "Failed to refresh agent stats");
    }
  };
  $("btn-test-proxy")?.addEventListener("click", refreshAgents);
  $("btn-refresh-agents")?.addEventListener("click", refreshAgents);
}

function initDevAuth(message) {
  hide($("firebase-auth-area"));
  show($("dev-auth-area"));
  const sub = $("dev-auth-area")?.querySelector(".dash-auth-sub");
  if (sub && message) sub.textContent = message;

  const saved = loadSession();
  if (saved?.mode === "dev" && saved.idToken && saved.email) {
    idToken = saved.idToken;
    currentUser = { email: saved.email, displayName: saved.displayName || saved.email.split("@")[0] };
    showDashboard(currentUser);
    return;
  }

  if (!authResolved) {
    authResolved = true;
    showAuth();
  }

  $("dev-auth-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("dev-email").value.trim();
    if (!email) return;
    const uid = email.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32);
    idToken = `dev:${uid}:${email}`;
    currentUser = { email, displayName: email.split("@")[0] };
    saveSession({
      mode: "dev",
      idToken,
      email,
      displayName: currentUser.displayName,
    });
    showDashboard(currentUser);
  });

  $("dash-signout").addEventListener("click", () => {
    idToken = null;
    currentUser = null;
    clearSession();
    showAuth();
  });
}

async function initFirebaseAuth() {
  hide($("dev-auth-area"));
  show($("firebase-auth-area"));

  cfg = normalizeFirebaseConfig(cfg);
  const app = initializeApp(cfg);
  auth = getAuth(app);
  await setPersistence(auth, browserLocalPersistence);

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  try {
    const redirectResult = await getRedirectResult(auth);
    if (redirectResult?.user) {
      const isNewUser = Boolean(getAdditionalUserInfo(redirectResult)?.isNewUser);
      await enterDashboard(redirectResult.user, { isNewUser });
    }
  } catch (err) {
    setError(isAuthNetworkError(err) ? AUTH_NETWORK_MESSAGE : err.message);
  }

  let authTab = "signup";
  const setAuthTab = (nextTab) => {
    authTab = nextTab === "signin" ? "signin" : "signup";
    document.querySelectorAll(".dash-auth-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === authTab);
    });
    const submit = $("auth-submit");
    if (submit) submit.textContent = authTab === "signup" ? "Create free account" : "Log in";
    const pw = $("auth-password");
    if (pw) pw.autocomplete = authTab === "signup" ? "new-password" : "current-password";
    // Default dashboard auth copy (plugin OAuth uses applyConnectAuthCopy)
    if (!connectCodeFromUrl()) {
      const title = $("auth-title");
      const subtitle = $("auth-subtitle");
      const label = document.querySelector(".dash-auth-card .dash-section-label");
      if (label) label.textContent = authTab === "signup" ? "Free to start" : "Welcome back";
      if (title) {
        title.textContent = authTab === "signup" ? "Get your free API key" : "Log in";
      }
      if (subtitle) {
        subtitle.textContent =
          authTab === "signup"
            ? "1M free tokens/mo · then $0.30/1M. Google takes one click — your key is ready instantly."
            : "Sign in to manage API keys, usage, and billing.";
      }
      document.querySelectorAll(".dash-auth-tab").forEach((t) => {
        t.setAttribute("aria-selected", t.dataset.tab === authTab ? "true" : "false");
      });
    }
  };

  function applyConnectAuthCopy() {
    const code = connectCodeFromUrl();
    if (!code) return;
    const title = $("auth-title");
    const subtitle = $("auth-subtitle");
    const label = document.querySelector(".dash-auth-card .dash-section-label");
    if (label) label.textContent = "Coding agent plugin";
    if (title) title.textContent = "Connect your SuperCompress account";
    if (subtitle) {
      subtitle.textContent =
        "Sign in to link this device. SuperCompress will create your account key automatically for the plugin.";
    }
  }

  document.querySelectorAll(".dash-auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => setAuthTab(tab.dataset.tab));
  });

  const authParams = new URLSearchParams(window.location.search);
  applyConnectAuthCopy();
  const wantLogin =
    authParams.get("login") === "1" ||
    authParams.get("login") === "true" ||
    authParams.get("mode") === "login" ||
    authParams.get("mode") === "signin";
  const wantSignup =
    authParams.get("signup") === "1" ||
    authParams.get("signup") === "true" ||
    authParams.get("mode") === "signup";
  // Default to signup — login only when explicitly requested (or plugin connect).
  if (wantLogin && !wantSignup && !connectCodeFromUrl()) {
    setAuthTab("signin");
  } else {
    setAuthTab("signup");
  }

  $("btn-google").addEventListener("click", async () => {
    setError("");
    try {
      const result = await signInWithPopup(auth, provider);
      if (result?.user) {
        const isNewUser = Boolean(getAdditionalUserInfo(result)?.isNewUser);
        await enterDashboard(result.user, { isNewUser });
      }
    } catch (err) {
      const code = String(err?.code || "");
      if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
        await signInWithRedirect(auth, provider);
        return;
      }
      setError(isAuthNetworkError(err) ? AUTH_NETWORK_MESSAGE : err.message);
    }
  });

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("");
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    try {
      let result;
      let isNewUser = false;
      if (authTab === "signup") {
        result = await createUserWithEmailAndPassword(auth, email, password);
        isNewUser = true;
      } else {
        result = await signInWithEmailAndPassword(auth, email, password);
      }
      if (result?.user) await enterDashboard(result.user, { isNewUser });
    } catch (err) {
      setError(err.message);
    }
  });

  onAuthStateChanged(auth, async (user) => {
    authResolved = true;
    if (user) {
      try {
        // Returning sessions: server still welcomes if account is <24h and not yet emailed.
        await enterDashboard(user, { isNewUser: false });
      } catch (err) {
        console.error("Firebase token acquisition failed", err);
        idToken = null;
        currentUser = null;
        clearSession();
        await signOut(auth).catch(() => {});
        showAuth();
        setError(isAuthNetworkError(err) ? AUTH_NETWORK_MESSAGE : err.message);
      }
    } else {
      idToken = null;
      currentUser = null;
      clearSession();
      showAuth();
    }
  });

  const signOutBtn = $("dash-signout");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", async () => {
      clearSession();
      if (auth) await signOut(auth);
      else {
        idToken = null;
        showAuth();
      }
    });
  }
}

function firebaseConfigReady(source) {
  const normalized = normalizeFirebaseConfig(source);
  return Boolean(normalized.apiKey && normalized.projectId && normalized.authDomain);
}

async function loadFirebaseConfig() {
  cfg = normalizeFirebaseConfig(cfg);
  if (firebaseConfigReady(cfg)) return true;

  try {
    const base = apiBaseUrl();
    const res = await fetch(`${base}/api/firebase-config`, { cache: "no-store" });
    if (res.ok) {
      const remote = normalizeFirebaseConfig(await res.json());
      if (firebaseConfigReady(remote)) {
        cfg = remote;
        return true;
      }
    }
  } catch (_) {
    /* fall back to baked config */
  }
  return firebaseConfigReady(cfg);
}

async function loadAuthStatus() {
  try {
    const res = await fetch(`${apiBaseUrl()}/api/auth-status`, { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch (_) {
    /* ignore */
  }
  return null;
}

async function init() {
  initPanels();
  initModals();
  initSnippetTabs();
  initBilling();
  show(viewAuth);
  setError("");
  hide(viewDash);
  hide($("dash-profile"));
  await detectApiMode();
  const firebaseReady = await loadFirebaseConfig();
  if (firebaseReady) {
    try {
      await initFirebaseAuth();
    } catch (err) {
      console.error("Firebase auth init failed", err);
      initDevAuth("Firebase sign-in failed to initialize. The Firebase project config is invalid or blocked by the browser. Check FIREBASE_* on Vercel, then redeploy.");
    }
    return;
  }

  const status = await loadAuthStatus();
  const devAllowed = status?.sc_auth_dev === true;
  const hint = status?.note
    ? `${status.note} Add FIREBASE_* env vars on Vercel and redeploy to enable Google sign-in.`
    : "Firebase client config missing. Add FIREBASE_* env vars on Vercel, redeploy, then refresh.";

  if (devAllowed) {
    initDevAuth("Firebase client config is not available yet. Dev mode is enabled — enter any email to continue, or configure FIREBASE_* on Vercel and redeploy.");
  } else {
    initDevAuth(hint);
  }
}

init();
