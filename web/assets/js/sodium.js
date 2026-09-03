// node_modules/sodium-webmcp-sdk/dist/index.js
var b = { "sodium-production-2026-09-02": { crv: "Ed25519", x: "5qhcunvHkzmVNKhPsVXloUB5CsfvzZvgA_sGEvQ1cxY", kty: "OKP" } };
function _(e) {
  return typeof e == "object" && e !== null && !Array.isArray(e);
}
function Q(e) {
  let t = {}, n = [];
  for (let [r, s] of Object.entries(e ?? {})) if (typeof s == "string") t[r] = { type: s }, n.push(r);
  else {
    let { optional: a, ...i } = s;
    t[r] = i, !a && i.default === void 0 && n.push(r);
  }
  return { type: "object", properties: t, required: n, additionalProperties: false };
}
function ee(e) {
  return "navigate" in e ? { kind: "navigate", urlTemplate: e.navigate } : "extract" in e ? { kind: "extract", fields: e.extract.fields } : "form" in e ? { kind: "form", formSelector: e.form.selector, fieldMap: e.form.fields ?? {}, submitSelector: e.form.submit } : "interaction" in e ? { kind: "interaction", steps: e.interaction.steps.map((t) => t.kind === "wait_for" ? { ...t, timeoutMs: t.timeoutMs ?? 3e3 } : t), postcondition: e.interaction.expect } : "request" in e ? { kind: "request", method: e.request.method, pathTemplate: e.request.path, queryMap: e.request.query, body: e.request.body ? { encoding: e.request.body.encoding, fieldMap: e.request.body.fields } : void 0, response: e.request.response ?? "json" } : { kind: "call", export: e.call };
}
function te(e) {
  let t = e.split("_").filter(Boolean);
  if (t.length === 0) return e;
  let [n, ...r] = t;
  return [n.charAt(0).toUpperCase() + n.slice(1), ...r].join(" ");
}
function ne(e) {
  let t = e.risk, n = t === "destructive" || t === "financial" ? "required" : t === "state_changing" ? "recommended" : "none", r = { none: 0, recommended: 1, required: 2 }, s = e.confirmation ?? n, a = r[s] >= r[n] ? s : n;
  return { id: e.id, name: e.name, title: e.title ?? te(e.name), description: e.description, inputSchema: Q(e.input), output: e.output, routes: e.on.map((i) => typeof i == "string" ? { pathPattern: i } : { pathPattern: i.path, requiresSelector: i.when }), handler: ee(e.run), riskLevel: t, confirmation: a, annotations: { readOnlyHint: t === "read_only", destructiveHint: t === "destructive" || t === "financial", idempotentHint: t === "read_only" || t === "reversible", openWorldHint: false } };
}
function L(e) {
  if (!_(e) || e.schemaVersion !== 1 || !_(e.app) || typeof e.app.name != "string" || !Array.isArray(e.app.origins) || e.app.origins.length === 0 || !e.app.origins.every((t) => typeof t == "string") || !Array.isArray(e.tools) || e.tools.length === 0 || e.tools.length > 128) return null;
  for (let t of e.tools) {
    let n = _(t) && _(t.run) ? t.run : null, r = n ? ["navigate", "extract", "form", "interaction", "request", "call"].filter((s) => s in n) : [];
    if (!_(t) || typeof t.id != "string" || typeof t.name != "string" || typeof t.description != "string" || !_(t.run) || t.on !== void 0 && !Array.isArray(t.on) || !["read_only", "reversible", "state_changing", "destructive", "financial"].includes(String(t.risk)) || t.confirmation !== void 0 && !["none", "recommended", "required"].includes(String(t.confirmation)) || r.length !== 1) return null;
  }
  try {
    let t = e, n = e.tools.map((r) => ({ ...r, input: r.input ?? {}, on: r.on ?? ["/**"] }));
    return { schemaVersion: 1, app: t.app, telemetry: { enabled: t.telemetry?.enabled ?? true }, tools: n.map(ne) };
  } catch {
    return null;
  }
}
function w(e, t) {
  let n = M(e), r = M(t);
  for (let s = 0; s < n.length; s++) {
    let a = n[s];
    if (a === "**") return true;
    let i = r[s];
    if (i === void 0) return false;
    if (a !== "*" && a !== i) return false;
  }
  return n.length === r.length;
}
function M(e) {
  return e.split("/").filter((t) => t.length > 0);
}
function v(e, t) {
  let n = false, r = e.replace(/\{([a-zA-Z0-9_]+)\}/g, (s, a) => {
    let i = t[a];
    return i == null ? (n = true, "") : encodeURIComponent(String(i));
  });
  return n || !r.startsWith("/") || r.startsWith("//") ? null : r;
}
function x(e, t, n = "$") {
  let r = [], s = (a) => r.push(`${n}: ${a}`);
  if (e.const !== void 0 && t !== e.const) return s("expected const value"), r;
  if (e.enum && !e.enum.some((a) => a === t)) return s("value not in enum"), r;
  switch (e.type) {
    case "object": {
      if (typeof t != "object" || t === null || Array.isArray(t)) return [...r, `${n}: expected object`];
      let a = t;
      for (let i of e.required ?? []) i in a || r.push(`${n}.${i}: missing required property`);
      for (let [i, u] of Object.entries(a)) {
        let o = e.properties?.[i];
        o ? r.push(...x(o, u, `${n}.${i}`)) : e.additionalProperties === false && r.push(`${n}.${i}: unexpected property`);
      }
      return r;
    }
    case "array":
      return Array.isArray(t) ? (e.items && t.forEach((a, i) => r.push(...x(e.items, a, `${n}[${i}]`))), r) : [...r, `${n}: expected array`];
    case "string": {
      if (typeof t != "string") return [...r, `${n}: expected string`];
      if (e.minLength !== void 0 && t.length < e.minLength && s("below minLength"), e.maxLength !== void 0 && t.length > e.maxLength && s("above maxLength"), e.pattern !== void 0) try {
        new RegExp(e.pattern).test(t) || s("pattern mismatch");
      } catch {
        s("invalid pattern");
      }
      return r;
    }
    case "number":
    case "integer":
      return typeof t != "number" || Number.isNaN(t) ? [...r, `${n}: expected number`] : (e.type === "integer" && !Number.isInteger(t) && s("expected integer"), e.minimum !== void 0 && t < e.minimum && s("below minimum"), e.maximum !== void 0 && t > e.maximum && s("above maximum"), r);
    case "boolean":
      return typeof t != "boolean" && s("expected boolean"), r;
    default:
      return r;
  }
}
var R = 256 * 1024;
async function D(e, t, n, r, s = {}) {
  let a = x(e.inputSchema, t ?? {});
  if (a.length > 0) return { ok: false, error: "invalid_input", issues: a.slice(0, 10) };
  let i = t ?? {};
  if (e.confirmation === "required" && !await se(n, e, r)) return { ok: false, error: "user_denied" };
  switch (e.handler.kind) {
    case "navigate": {
      let u = v(e.handler.urlTemplate, i);
      if (!u) return { ok: false, error: "unresolved_url_template" };
      let o = n.defaultView;
      return o ? (o.location.assign(u), { ok: true, navigatedTo: u, note: "navigation started; tools re-register on the new page" }) : { ok: false, error: "no_window" };
    }
    case "extract": {
      let u = {};
      for (let o of e.handler.fields) if (o.all) {
        let l = [...n.querySelectorAll(o.selector)];
        u[o.name] = l.map((c) => A(c, o.attribute)).slice(0, 200);
      } else {
        let l = n.querySelector(o.selector);
        u[o.name] = l ? A(l, o.attribute) : null;
      }
      return { ok: true, data: u };
    }
    case "form": {
      let u = N(n, e.handler.formSelector);
      if (!u.ok) return u.error === "element_not_found" ? { ok: false, error: "form_not_found" } : u;
      let o = u.element;
      if (o.tagName !== "FORM") return { ok: false, error: "form_not_found" };
      let l = o, c = S(o);
      if (c) return { ok: false, error: c };
      for (let [f, g] of Object.entries(e.handler.fieldMap)) {
        let p = i[f];
        if (p === void 0) continue;
        let y = l.elements.namedItem(g);
        if (!y) return { ok: false, error: "form_field_missing", field: g };
        if (!H(y, String(p))) return { ok: false, error: "form_field_not_settable", field: g };
      }
      let d = e.handler.submitSelector ? l.querySelectorAll(e.handler.submitSelector) : null;
      if (d?.length === 0) return { ok: false, error: "submitter_not_found" };
      if (d && d.length > 1) return { ok: false, error: "selector_not_unique", selector: e.handler.submitSelector };
      let m = d?.[0] ?? null;
      return m && S(m) ? { ok: false, error: S(m) } : (typeof l.requestSubmit == "function" ? l.requestSubmit(m instanceof HTMLElement ? m : void 0) : l.submit(), { ok: true, submitted: true });
    }
    case "interaction": {
      let u = {};
      for (let o of e.handler.steps) {
        if (r?.aborted) return { ok: false, error: "aborted" };
        if (o.kind === "wait_for") {
          if (!await P(n, o.selector, o.state, o.timeoutMs, r)) return { ok: false, error: "wait_timeout", selector: o.selector };
          continue;
        }
        let l = o.kind === "submit" ? o.formSelector : "selector" in o ? o.selector : void 0, c = o.kind === "click" && "role" in o ? o : null, d = c ? re(n, c.name) : N(n, l);
        if (!d.ok) return d;
        if (o.kind === "read") {
          u[o.output] = A(d.element, o.attribute);
          continue;
        }
        let m = S(d.element);
        if (m) return { ok: false, error: m, ...l ? { selector: l } : { name: c?.name ?? "" } };
        if (o.kind === "set") {
          if (!(o.input in i)) return { ok: false, error: "interaction_input_missing", input: o.input };
          if (!H(d.element, String(i[o.input]))) return { ok: false, error: "element_not_settable", selector: l };
        } else if (o.kind === "click") {
          if (!(d.element instanceof HTMLElement)) return { ok: false, error: "element_not_clickable" };
          d.element.click();
        } else {
          if (d.element.tagName !== "FORM") return { ok: false, error: "form_not_found" };
          let f = d.element, g = o.submitSelector ? f.querySelectorAll(o.submitSelector) : null;
          if (g?.length === 0) return { ok: false, error: "submitter_not_found" };
          if (g && g.length > 1) return { ok: false, error: "selector_not_unique", selector: o.submitSelector };
          let p = g?.[0];
          if (p && S(p)) return { ok: false, error: S(p), selector: o.submitSelector };
          typeof f.requestSubmit == "function" ? f.requestSubmit(p) : f.submit();
        }
      }
      return e.handler.postcondition && !await ie(n, e.handler.postcondition, 3e3, r) ? { ok: false, error: "postcondition_failed" } : { ok: true, data: u };
    }
    case "request": {
      let u = v(e.handler.pathTemplate, i);
      if (!u || !u.startsWith("/") || u.startsWith("//")) return { ok: false, error: "unresolved_path_template" };
      let o = n.defaultView;
      if (!o) return { ok: false, error: "no_window" };
      let l = new URL(u, o.location.origin);
      if (l.origin !== o.location.origin) return { ok: false, error: "cross_origin_request" };
      for (let [y, k] of Object.entries(e.handler.queryMap ?? {})) {
        let h = i[y];
        h !== void 0 && l.searchParams.set(k, String(h));
      }
      let c = new Headers(), d;
      if (e.handler.body) {
        let y = {};
        for (let [k, h] of Object.entries(e.handler.body.fieldMap)) i[k] !== void 0 && (y[h] = String(i[k]));
        e.handler.body.encoding === "json" ? (c.set("content-type", "application/json"), d = JSON.stringify(y)) : (c.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8"), d = new URLSearchParams(y));
      }
      let m = o.fetch?.bind(o) ?? globalThis.fetch;
      if (!m) return { ok: false, error: "fetch_unavailable" };
      let f;
      try {
        f = await m(l, { method: e.handler.method, credentials: "same-origin", redirect: "error", headers: c, body: d, signal: r });
      } catch {
        return { ok: false, error: r?.aborted ? "aborted" : "request_failed" };
      }
      if (Number(f.headers.get("content-length") ?? 0) > R) return { ok: false, error: "response_too_large", status: f.status };
      if (e.handler.response === "status") return { ok: f.ok, status: f.status };
      let p = await f.text();
      if (new TextEncoder().encode(p).byteLength > R) return { ok: false, error: "response_too_large", status: f.status };
      if (!f.ok) return { ok: false, error: "request_rejected", status: f.status };
      if (e.handler.response === "text") return { ok: true, status: f.status, data: p };
      try {
        return { ok: true, status: f.status, data: JSON.parse(p) };
      } catch {
        return { ok: false, error: "invalid_json_response", status: f.status };
      }
    }
    case "call": {
      let u = s[e.handler.export];
      if (!u) return { ok: false, error: "handler_not_registered", handler: e.handler.export };
      try {
        let o = await u(i, { signal: r, document: n });
        return typeof o == "object" && o !== null && "ok" in o && typeof o.ok == "boolean" ? o : o === void 0 ? { ok: true } : { ok: true, data: o };
      } catch (o) {
        return { ok: false, error: r?.aborted ? "aborted" : "handler_exception", message: o instanceof Error ? o.message.slice(0, 240) : "custom handler failed" };
      }
    }
  }
}
function re(e, t) {
  let n = E(t), r = [...e.querySelectorAll("button, input[type=button], input[type=submit]")].filter((s) => oe(s) === n);
  return r.length === 0 ? { ok: false, error: "element_not_found", name: t } : r.length > 1 ? { ok: false, error: "accessible_target_not_unique", name: t } : { ok: true, element: r[0] };
}
function oe(e) {
  let t = e.getAttribute("aria-label");
  return t ? E(t) : e instanceof HTMLInputElement ? E(e.value) : E(e.textContent ?? "");
}
function E(e) {
  return e.replace(/\s+/g, " ").trim();
}
function N(e, t) {
  let n;
  try {
    n = e.querySelectorAll(t);
  } catch {
    return { ok: false, error: "invalid_selector", selector: t };
  }
  return n.length === 0 ? { ok: false, error: "element_not_found", selector: t } : n.length > 1 ? { ok: false, error: "selector_not_unique", selector: t } : { ok: true, element: n[0] };
}
function S(e) {
  if (!e.isConnected) return "element_disconnected";
  if (e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true") return "element_not_visible";
  let t = e.ownerDocument.defaultView?.getComputedStyle(e);
  return t?.display === "none" || t?.visibility === "hidden" ? "element_not_visible" : e.disabled || e.getAttribute("aria-disabled") === "true" ? "element_disabled" : null;
}
async function P(e, t, n, r, s) {
  let a = () => {
    try {
      return e.querySelector(t) !== null == (n === "present");
    } catch {
      return false;
    }
  };
  return a() ? true : new Promise((i) => {
    let u = false, o = (m) => {
      u || (u = true, l.disconnect(), clearTimeout(d), s?.removeEventListener("abort", c), i(m));
    }, l = new MutationObserver(() => {
      a() && o(true);
    }), c = () => o(false), d = setTimeout(() => o(false), r);
    l.observe(e.documentElement, { childList: true, subtree: true, attributes: true }), s?.addEventListener("abort", c, { once: true });
  });
}
function q(e, t) {
  return t.kind === "selector_present" ? e.querySelector(t.selector) !== null : t.kind === "selector_absent" ? e.querySelector(t.selector) === null : w(t.pathPattern, e.defaultView?.location.pathname ?? "/");
}
async function ie(e, t, n, r) {
  if (t.kind === "selector_present") return P(e, t.selector, "present", n, r);
  if (t.kind === "selector_absent") return P(e, t.selector, "absent", n, r);
  if (q(e, t)) return true;
  let s = Date.now() + n;
  for (; !r?.aborted && Date.now() < s; ) if (await new Promise((a) => setTimeout(a, 25)), q(e, t)) return true;
  return false;
}
async function se(e, t, n) {
  if (n?.aborted) return false;
  let r = e.createElement("dialog"), s = `sodium-confirm-${t.name}`;
  r.setAttribute("aria-labelledby", s), r.setAttribute("role", "alertdialog"), r.style.cssText = "max-width:30rem;border:1px solid #d4d4d4;border-radius:12px;padding:24px;background:#fff;color:#171717;font:14px/1.5 system-ui;box-shadow:0 20px 50px #0004";
  let a = e.createElement("h2");
  a.id = s, a.textContent = `Confirm ${t.title}`, a.style.cssText = "margin:0 0 8px;font-size:18px";
  let i = e.createElement("p");
  i.textContent = t.description, i.style.cssText = "margin:0 0 20px";
  let u = e.createElement("button");
  u.type = "button", u.textContent = "Cancel", u.dataset.sodiumCancel = "";
  let o = e.createElement("button");
  return o.type = "button", o.textContent = "Confirm", o.dataset.sodiumConfirm = "", o.style.cssText = "margin-left:8px", r.append(a, i, u, o), e.body.append(r), r.showModal?.(), r.open || r.setAttribute("open", ""), new Promise((l) => {
    let c = (m) => {
      n?.removeEventListener("abort", d), r.remove(), l(m);
    }, d = () => c(false);
    o.addEventListener("click", () => c(true), { once: true }), u.addEventListener("click", () => c(false), { once: true }), r.addEventListener("cancel", () => c(false), { once: true }), n?.addEventListener("abort", d, { once: true }), o.focus();
  });
}
function A(e, t) {
  return t ? e.getAttribute(t) : (e.textContent ?? "").trim();
}
function H(e, t) {
  if (e instanceof HTMLInputElement) {
    if (e.type === "checkbox" || e.type === "radio") {
      let n = t === "true" || t === "on" || t === e.value;
      T(e, "checked", n);
    } else T(e, "value", t);
    return j(e), true;
  }
  return e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement ? (T(e, "value", t), j(e), true) : typeof RadioNodeList < "u" && e instanceof RadioNodeList ? (e.value = t, true) : false;
}
function T(e, t, n) {
  let r = Object.getPrototypeOf(e), s = Object.getOwnPropertyDescriptor(r, t);
  s?.set ? s.set.call(e, n) : e[t] = n;
}
function j(e) {
  e.dispatchEvent(new Event("input", { bubbles: true })), e.dispatchEvent(new Event("change", { bubbles: true }));
}
var ae = "0.2.0";
var U = "sodium.session.v1";
var le = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var $ = [{ name: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"], campaigns: ["chatgpt", "openai", "chatgpt.com", "chat.openai.com"] }, { name: "Claude", hosts: ["claude.ai"], campaigns: ["claude", "anthropic", "claude.ai"] }, { name: "Perplexity", hosts: ["perplexity.ai"], campaigns: ["perplexity", "perplexity.ai"] }, { name: "Gemini", hosts: ["gemini.google.com"], campaigns: ["gemini", "google-gemini", "gemini.google.com"] }, { name: "Copilot", hosts: ["copilot.microsoft.com"], campaigns: ["copilot", "microsoft-copilot", "copilot.microsoft.com"] }, { name: "Grok", hosts: ["grok.com"], campaigns: ["grok", "xai", "grok.com"] }, { name: "DeepSeek", hosts: ["chat.deepseek.com"], campaigns: ["deepseek", "chat.deepseek.com"] }, { name: "Mistral", hosts: ["chat.mistral.ai"], campaigns: ["mistral", "le-chat", "chat.mistral.ai"] }, { name: "You.com", hosts: ["you.com"], campaigns: ["you", "you.com"] }];
var ue = ["utm_source", "source", "ref", "referrer"];
function ce(e, t) {
  return e === t || e.endsWith(`.${t}`);
}
function de(e) {
  let t = e.toLowerCase().replace(/\.$/, "");
  return $.find((n) => n.hosts.some((r) => ce(t, r)))?.name ?? null;
}
function fe(e) {
  let t = e.trim().toLowerCase();
  try {
    return new URL(t).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return t;
  }
}
function me(e) {
  let t = fe(e);
  return $.find((n) => n.campaigns.some((r) => r === t))?.name ?? null;
}
function V(e, t = e.document) {
  if (t.referrer) try {
    let n = de(new URL(t.referrer).hostname);
    if (n) return { answerEngine: n, attributionMethod: "referrer" };
  } catch {
  }
  try {
    let n = new URL(e.location.href).searchParams;
    for (let r of ue) {
      let s = n.get(r);
      if (!s) continue;
      let a = me(s);
      if (a) return { answerEngine: a, attributionMethod: "campaign" };
    }
  } catch {
  }
  return null;
}
function O(e) {
  return typeof e.crypto?.randomUUID == "function" ? e.crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (t) => (Number(t) ^ e.crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(t) / 4).toString(16));
}
function pe(e) {
  try {
    let t = e.sessionStorage.getItem(U);
    if (t && le.test(t)) return t;
    let n = O(e);
    return e.sessionStorage.setItem(U, n), n;
  } catch {
    return O(e);
  }
}
function W(e, t) {
  let n = 0, r = t ? pe(t) : void 0;
  return { event(s, a = {}) {
    if (!e || !t || n >= 100) return;
    n++;
    let i = JSON.stringify({ projectId: e.projectId, key: e.publishableKey, deploymentId: e.deploymentId, configVersion: e.configVersion, sdkVersion: ae, sessionId: r, event: s, ...a, ts: Date.now() });
    try {
      if (typeof t.navigator?.sendBeacon == "function" && t.navigator.sendBeacon(new URL("/api/events", e.endpoint).toString(), new Blob([i], { type: "text/plain;charset=UTF-8" }))) return;
      t.fetch(new URL("/api/events", e.endpoint), { method: "POST", body: i, headers: { "content-type": "text/plain;charset=UTF-8" }, keepalive: true, credentials: "omit" }).catch(() => {
      });
    } catch {
    }
  } };
}
var B = { event: () => {
} };
function K(e) {
  let t = e.modelContext ?? e.defaultView?.navigator?.modelContext ?? null;
  return t && typeof t.registerTool == "function" ? t : null;
}
function ge(e, t) {
  return { name: e.name, title: e.title, description: ye(e), inputSchema: e.inputSchema, annotations: { readOnlyHint: e.annotations.readOnlyHint, untrustedContentHint: e.handler.kind === "extract" }, execute: t };
}
function ye(e) {
  let t = [];
  return e.annotations.destructiveHint ? t.push("DESTRUCTIVE action") : e.annotations.readOnlyHint || t.push("changes application state"), e.confirmation === "required" ? t.push("requires explicit user confirmation before use") : e.confirmation === "recommended" && t.push("confirm with the user before use"), t.length > 0 ? `${e.description} [${t.join("; ")}]` : e.description;
}
function F(e, t, n, r, s) {
  let a = /* @__PURE__ */ new Map(), i = 0, u = (o) => {
    let l = t.defaultView, c = l ? he(l.location) : "/";
    return o.routes.some((d) => !(!w(d.pathPattern, c) || d.requiresSelector && !t.querySelector(d.requiresSelector)));
  };
  return { async sync() {
    let o = ++i;
    for (let l of n) {
      let c = a.has(l.name), d = u(l);
      c && !d && (a.get(l.name).abort(), a.delete(l.name), s?.("unregistered", l.name));
    }
    for (let l of n) {
      if (i !== o) return;
      if (a.has(l.name) || !u(l)) continue;
      let c = new AbortController();
      try {
        await e.registerTool(ge(l, r(l)), { signal: c.signal }), a.set(l.name, c), s?.("registered", l.name);
      } catch {
        s?.("register_failed", l.name);
      }
    }
  }, dispose() {
    i++;
    for (let [o, l] of a) l.abort(), s?.("unregistered", o);
    a.clear();
  }, registered() {
    return [...a.keys()].sort();
  } };
}
function J(e, t) {
  let n = e.navigation;
  if (n && typeof n.addEventListener == "function") {
    let o = () => queueMicrotask(t);
    return n.addEventListener("currententrychange", o), () => n.removeEventListener("currententrychange", o);
  }
  let r = e.history, s = r.pushState.bind(r), a = r.replaceState.bind(r);
  r.pushState = (...o) => {
    s(...o), queueMicrotask(t);
  }, r.replaceState = (...o) => {
    a(...o), queueMicrotask(t);
  };
  let i = () => queueMicrotask(t), u = () => queueMicrotask(t);
  return e.addEventListener("popstate", i), e.addEventListener("hashchange", u), () => {
    r.pushState = s, r.replaceState = a, e.removeEventListener("popstate", i), e.removeEventListener("hashchange", u);
  };
}
function he(e) {
  return e.hash.startsWith("#/") ? `/#${e.hash.slice(1)}` : e.pathname || "/";
}
var be = b;
function G(e) {
  return typeof e == "object" && e !== null && !Array.isArray(e);
}
function Y(e, t) {
  let n = Object.keys(e).sort();
  return n.length === t.length && t.sort().every((r, s) => n[s] === r);
}
function z(e) {
  let t = e.replace(/-/g, "+").replace(/_/g, "/"), n = t + "=".repeat((4 - t.length % 4) % 4), r = atob(n);
  return Uint8Array.from(r, (s) => s.charCodeAt(0));
}
function ke(e) {
  return !G(e) || !Y(e, ["configHash", "deploymentId", "origins", "projectId", "receiptVersion", "version"]) || e.receiptVersion !== 1 || typeof e.projectId != "string" || !/^prj_[a-z0-9]{8,24}$/.test(e.projectId) || typeof e.deploymentId != "string" || !/^dep_[a-z0-9]{12,24}$/.test(e.deploymentId) || typeof e.version != "number" || !Number.isInteger(e.version) || e.version < 1 || typeof e.configHash != "string" || !/^[a-f0-9]{64}$/.test(e.configHash) || !Array.isArray(e.origins) || e.origins.length < 1 || e.origins.length > 8 || !e.origins.every((t) => {
    if (typeof t != "string") return false;
    try {
      return new URL(t).origin === t;
    } catch {
      return false;
    }
  }) ? null : e;
}
async function _e(e, t) {
  try {
    let n = await t.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(e)));
    return Array.from(new Uint8Array(n), (r) => r.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}
async function Z(e, t, n, r, s = be) {
  let a = t?.deployment;
  if (!t || !a) return { ok: false, error: "deployment_missing" };
  let i = a.receipt;
  if (!i) return { ok: false, error: "receipt_missing" };
  if (!G(i) || !Y(i, ["algorithm", "keyId", "payload", "signature"]) || i.algorithm !== "Ed25519" || typeof i.keyId != "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(i.keyId) || typeof i.payload != "string" || i.payload.length < 1 || i.payload.length > 4096 || !/^[a-zA-Z0-9_-]+$/.test(i.payload) || typeof i.signature != "string" || i.signature.length < 1 || i.signature.length > 256 || !/^[a-zA-Z0-9_-]+$/.test(i.signature)) return { ok: false, error: "receipt_shape" };
  let u = s[i.keyId];
  if (!u) return { ok: false, error: "unknown_key" };
  if (!r?.subtle) return { ok: false, error: "webcrypto_unavailable" };
  let o, l;
  try {
    o = z(i.payload), l = z(i.signature);
  } catch {
    return { ok: false, error: "receipt_shape" };
  }
  try {
    let m = await r.subtle.importKey("jwk", u, { name: "Ed25519" }, false, ["verify"]);
    if (!await r.subtle.verify({ name: "Ed25519" }, m, l, o)) return { ok: false, error: "signature_invalid" };
  } catch {
    return { ok: false, error: "signature_invalid" };
  }
  let c = null;
  try {
    c = ke(JSON.parse(new TextDecoder().decode(o)));
  } catch {
  }
  if (!c) return { ok: false, error: "payload_invalid" };
  if (c.projectId !== t.projectId || c.deploymentId !== a.id || c.version !== a.version || c.configHash !== a.configHash) return { ok: false, error: "deployment_mismatch" };
  let d = await _e(e, r);
  return !d || d !== c.configHash ? { ok: false, error: "config_mismatch" } : JSON.stringify(c.origins) !== JSON.stringify(e.app.origins) || !c.origins.includes(n) ? { ok: false, error: "origin_mismatch" } : { ok: true, payload: c };
}
async function Ke(e) {
  let t = e.document ?? globalThis.document, n = t?.defaultView ?? null, r = { available: false, registered: () => [], refresh: async () => {
  }, dispose: () => {
  } };
  if (!t || !n) return r;
  let s = L(e.config);
  if (!s) return e.debug && n.console.error("[sodium] invalid sodium.json"), r;
  let a = await Z(s, e.project, n.location.origin, n.crypto);
  if (!a.ok) return e.debug && n.console.warn(`[sodium] tools disabled (${a.error}). Run npx sodiumtools deploy, then rebuild the application.`), r;
  let i = s.telemetry.enabled && e.project ? W({ endpoint: e.project.endpoint, projectId: e.project.projectId, publishableKey: e.project.publishableKey, deploymentId: e.project.deployment?.id, configVersion: e.project.deployment?.version }, n) : B, u = V(n, t);
  u && i.event("answer_engine_referral", u);
  let o = K(t);
  if (!o) return e.debug && n.console.info("[sodium] WebMCP is unavailable"), r;
  let l = F(o, t, s.tools, (f) => async (g, p) => {
    let y = n.crypto.randomUUID?.() ?? Se(), k = performance.now();
    i.event("tool_started", { toolId: f.id, toolName: f.name, invocationId: y });
    let h = await D(f, g, t, p?.signal, e.handlers), C = { toolId: f.id, toolName: f.name, invocationId: y, durationMs: Math.round(performance.now() - k) };
    if (h.ok) i.event("tool_succeeded", C);
    else {
      let I = typeof h.error == "string" ? h.error : "unknown";
      i.event(I === "user_denied" ? "confirmation_denied" : "tool_failed", { ...C, errorCode: I });
    }
    return h;
  }, (f, g) => {
    let p = s.tools.find((y) => y.name === g);
    f === "registered" ? i.event("tool_registered", { toolId: p?.id, toolName: g }) : f === "register_failed" && i.event("tool_register_failed", { toolId: p?.id, toolName: g });
  });
  await l.sync(), i.event("sdk_ready");
  let c = J(n, () => {
    l.sync();
  }), d = false, m = new n.MutationObserver(() => {
    d || (d = true, n.setTimeout(() => {
      d = false, l.sync();
    }, 200));
  });
  return m.observe(t.documentElement, { attributes: true, childList: true, subtree: true }), { available: true, registered: () => l.registered(), refresh: () => l.sync(), dispose() {
    m.disconnect(), c(), l.dispose();
  } };
}
function Se() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (e) => (Number(e) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(e) / 4).toString(16));
}

// sodium.json
var sodium_default = {
  $schema: "https://sodium.result.dev/schema/v1.json",
  schemaVersion: 1,
  app: {
    name: "supercompress",
    origins: [
      "https://www.supercompress.dev",
      "https://supercompress.dev",
      "http://localhost:3000",
      "http://127.0.0.1:3000"
    ]
  },
  telemetry: {
    enabled: true
  },
  tools: [
    {
      id: "tl_47020285",
      name: "open_home",
      title: "Open homepage",
      description: "Open the SuperCompress marketing homepage.",
      on: [
        "/**"
      ],
      run: {
        navigate: "/"
      },
      risk: "read_only"
    },
    {
      id: "tl_475fdb84",
      name: "open_playground",
      title: "Open playground",
      description: "Open the interactive SuperCompress playground to try prompt compression in the browser.",
      on: [
        "/**"
      ],
      run: {
        navigate: "/playground"
      },
      risk: "read_only"
    },
    {
      id: "tl_5342ae5e",
      name: "open_docs",
      title: "Open docs",
      description: "Open SuperCompress documentation (quickstart, API, coding agents).",
      on: [
        "/**"
      ],
      run: {
        navigate: "/docs/"
      },
      risk: "read_only"
    },
    {
      id: "tl_3d616509",
      name: "open_quickstart",
      title: "Open quickstart",
      description: "Open the SuperCompress quickstart guide.",
      on: [
        "/**"
      ],
      run: {
        navigate: "/docs/quickstart"
      },
      risk: "read_only"
    },
    {
      id: "tl_4738a3ac",
      name: "open_get_api_key",
      title: "Get API key",
      description: "Open the dashboard signup flow to create a free SuperCompress API key.",
      on: [
        "/**"
      ],
      run: {
        navigate: "/dashboard?signup=1"
      },
      risk: "read_only"
    },
    {
      id: "tl_d8d10ec4",
      name: "open_pricing",
      title: "Open pricing",
      description: "Open SuperCompress pricing and free-tier details on the homepage.",
      on: [
        "/**"
      ],
      run: {
        navigate: "/#pricing"
      },
      risk: "read_only"
    },
    {
      id: "tl_efa62eb4",
      name: "open_vs_headroom",
      title: "Compare vs Headroom",
      description: "Open the SuperCompress vs Headroom comparison page.",
      on: [
        "/**"
      ],
      run: {
        navigate: "/supercompress-vs-headroom"
      },
      risk: "read_only"
    },
    {
      id: "tl_1dcc0f92",
      name: "open_llms_txt",
      title: "Open llms.txt",
      description: "Open the machine-readable SuperCompress llms.txt index for answer engines.",
      on: [
        "/**"
      ],
      run: {
        navigate: "/llms.txt"
      },
      risk: "read_only"
    },
    {
      id: "tl_74a41d95",
      name: "compress_in_playground",
      title: "Compress in playground",
      description: "On the playground page, fill context and query, run SuperCompress, and return the compressed text plus stats.",
      input: {
        context: {
          type: "string",
          minLength: 1,
          maxLength: 2e5
        },
        query: {
          type: "string",
          minLength: 1,
          maxLength: 2e3,
          default: "Summarize this context."
        }
      },
      on: [
        "/playground",
        "/playground.html"
      ],
      run: {
        interaction: {
          steps: [
            {
              kind: "set",
              selector: "#context",
              input: "context"
            },
            {
              kind: "set",
              selector: "#query",
              input: "query"
            },
            {
              kind: "click",
              selector: "#compress"
            },
            {
              kind: "wait_for",
              selector: "#stats:not([hidden])",
              state: "present",
              timeoutMs: 1e4
            },
            {
              kind: "read",
              selector: "#output",
              output: "compressed_text"
            },
            {
              kind: "read",
              selector: "#stat-saved",
              output: "saved_pct"
            },
            {
              kind: "read",
              selector: "#stat-in",
              output: "tokens_in"
            },
            {
              kind: "read",
              selector: "#stat-out",
              output: "tokens_out"
            }
          ]
        }
      },
      risk: "reversible",
      confirmation: "none"
    },
    {
      id: "tl_b52b09fd",
      name: "read_playground_stats",
      title: "Read playground stats",
      description: "Read the latest compression stats shown on the playground page after a run.",
      on: [
        "/playground",
        "/playground.html"
      ],
      run: {
        extract: {
          fields: [
            {
              name: "tokens_removed",
              selector: "#stat-removed"
            },
            {
              name: "tokens_in",
              selector: "#stat-in"
            },
            {
              name: "tokens_out",
              selector: "#stat-out"
            },
            {
              name: "saved_pct",
              selector: "#stat-saved"
            },
            {
              name: "policy",
              selector: "#stat-policy"
            },
            {
              name: "mode",
              selector: "#stat-mode"
            },
            {
              name: "status",
              selector: "#status"
            }
          ]
        }
      },
      risk: "read_only"
    }
  ]
};

// .sodium/project.json
var project_default = null;

// web/assets/js/sodium-bootstrap.mjs
var handle = null;
async function mountSodium() {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  if (handle) {
    handle.dispose();
    handle = null;
  }
  handle = await Ke({
    config: sodium_default,
    project: project_default,
    debug: Boolean(window.__SODIUM_DEBUG__)
  });
  return handle;
}
if (typeof window !== "undefined") {
  const boot = () => {
    mountSodium().catch((err) => {
      if (window.__SODIUM_DEBUG__) console.warn("[sodium]", err);
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      handle?.dispose();
      handle = null;
    });
  }
}
export {
  mountSodium
};
