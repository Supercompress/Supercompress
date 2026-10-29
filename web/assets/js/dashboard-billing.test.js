const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const dashboardSource = fs.readFileSync(path.join(__dirname, "dashboard-api.js"), "utf8");
const onboardingSource = fs.readFileSync(path.join(__dirname, "dashboard-onboarding.js"), "utf8");

function loadFunctions(source, names, globals = {}) {
  const context = vm.createContext({ URL, URLSearchParams, console, ...globals });
  for (const name of names) {
    const pattern = new RegExp(`^( *)(?:async )?function ${name}\\(`, "m");
    const match = pattern.exec(source);
    assert.ok(match, `Function ${name} exists`);
    const rest = source.slice(match.index + match[0].length);
    const end = new RegExp(`^${match[1]}}`, "m").exec(rest);
    assert.ok(end, `Function ${name} closes`);
    vm.runInContext(source.slice(match.index, match.index + match[0].length + end.index + end[0].length), context);
  }
  return context;
}

function element() {
  const classes = new Set();
  const listeners = {};
  return {
    innerHTML: "", textContent: "", dataset: {}, listeners,
    addEventListener: (event, callback) => { listeners[event] = callback; },
    classList: {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name), toggle: () => {},
    },
    focus() {}, select() {},
  };
}

test("current billing state detects free and prepaid exhaustion, not historical key usage", () => {
  const { billingUsageState } = loadFunctions(dashboardSource, ["billingUsageState"]);
  assert.equal(billingUsageState().freeCap, 1_000_000);
  for (const sub of [
    { tokens_used_this_period: 1_000_000 },
    { free_tokens_remaining: 0 },
    { payg_enabled: true, credit_wallet: true, credit_balance_usd: 0, tokens_used_this_period: 1_100_000 },
    { payg_enabled: true, paywall: true, credit_balance_usd: 0 },
    { free_tokens_per_month: 0 },
  ]) assert.equal(billingUsageState(sub).limitHit, true, JSON.stringify(sub));
  for (const sub of [
    {}, { tokens_used_this_period: 999_999 },
    { tokens_used_this_period: 1_000_000, credit_balance_usd: 10 },
    { free_tokens_remaining: 0, payg_enabled: true },
    { free_tokens_remaining: 0, unlimited: true },
    { paywall: true, credit_balance_usd: 1 },
  ]) assert.equal(billingUsageState(sub).limitHit, false, JSON.stringify(sub));
});

test("exhausted CTA persists across renders and paid status clears it without checkout", () => {
  const banner = element();
  const button = element();
  let checkoutOpened = 0;
  const context = loadFunctions(dashboardSource, ["billingUsageState", "renderPaygNudge"], {
    $: (id) => id === "dash-payg-banner" ? banner : button,
    formatNum: String, escapeHtml: String, totalRequests: () => 0,
    handleEnablePayg: () => { checkoutOpened++; },
    document: { querySelector: () => ({ click() {} }) },
  });
  const exhausted = { payg_enabled: true, credit_wallet: true, credit_balance_usd: 0, tokens_used_this_period: 1_000_000 };
  context.renderPaygNudge(exhausted);
  context.renderPaygNudge(exhausted);
  assert.match(banner.innerHTML, /Compression paused/);
  assert.match(banner.innerHTML, /Add \$10 credits/);
  assert.equal(checkoutOpened, 0);
  button.listeners.click();
  assert.equal(checkoutOpened, 1);
  context.renderPaygNudge({ ...exhausted, credit_balance_usd: 10 });
  assert.equal(banner.classList.contains("hidden"), true);
});

test("billing hash wins after auth, hash changes route, and navigation clears stale hash", () => {
  const window = { location: { href: "https://example.test/dashboard?panel=analytics#billing" }, listeners: {} };
  window.addEventListener = (event, callback) => { window.listeners[event] = callback; };
  window.history = { replaceState: (_, __, next) => { window.location.href = `https://example.test${next}`; } };
  const nav = element();
  const panel = element();
  const context = loadFunctions(dashboardSource, ["requestedDashboardPanel", "openDashboardPanel", "initPanels"], {
    window, idToken: null, $: () => panel, loadSubscription() {}, requestAnimationFrame() {},
    document: { querySelector: () => nav, querySelectorAll: () => [] },
    paintBillingUsageMeter() {},
  });
  assert.equal(context.requestedDashboardPanel(), "billing");
  context.initPanels();
  let opened = "";
  const open = context.openDashboardPanel;
  context.openDashboardPanel = (name) => { opened = name; };
  window.listeners.hashchange();
  assert.equal(opened, "");
  context.idToken = "authenticated";
  window.listeners.hashchange();
  assert.equal(opened, "billing");
  context.openDashboardPanel = open;
  open("keys");
  assert.equal(new URL(window.location.href).hash, "");
  assert.equal(open('billing"]'), false);
  assert.match(dashboardSource, /requestedDashboardPanel\(\) === "billing"\s*\? false/);
  assert.match(dashboardSource, /const panel = requestedDashboardPanel\(\);\s*if \(panel/);
});

test("credit modal starts at $10, auto-recharge off, and never bypasses review", () => {
  const nodes = Object.fromEntries(["modal-credits", "credits-amount", "credits-error", "credits-modal-title", "credits-modal-lead", "credits-auto-recharge"].map((id) => [id, element()]));
  nodes["credits-auto-recharge"].checked = true;
  let alerts = 0;
  const context = loadFunctions(dashboardSource, ["creditLimitsFromSub", "openCreditsModal"], {
    $: (id) => nodes[id], lastBillingSub: { credit_limit_usd: 250 },
    syncCreditsPresets() {}, syncCreditsHint() {}, alert: () => { alerts++; },
    handleEnablePaygCheckout: () => assert.fail("Must not skip credit review"),
  });
  context.openCreditsModal();
  assert.equal(nodes["credits-amount"].value, "10");
  assert.equal(nodes["credits-auto-recharge"].checked, false);
  delete nodes["modal-credits"];
  context.openCreditsModal();
  assert.equal(alerts, 1);
});

test("payment returns select billing without dropping checkout reconciliation parameters", () => {
  for (const status of ["success", "cancel"]) {
    const href = `https://www.supercompress.dev/dashboard?billing=${status}&session_id=cs_test_return#keys`;
    const { requestedDashboardPanel } = loadFunctions(dashboardSource, ["requestedDashboardPanel"], {
      window: { location: { href } },
    });
    assert.equal(requestedDashboardPanel(), "billing");
    assert.equal(new URL(href).searchParams.get("session_id"), "cs_test_return");
  }
});

test("checkout return processing waits for authentication", () => {
  const context = loadFunctions(dashboardSource, ["initBilling"], {
    idToken: null,
    window: { location: { search: "?billing=success&session_id=cs_test_return" } },
    apiFetch: () => assert.fail("Unauthenticated reconciliation"),
  });
  context.initBilling();
  assert.match(dashboardSource, /openDashboardPanel\(panel, \{ updateUrl: false \}\);\s*} catch \(_\) \{\}\s*initBilling\(\)/);
  const initSource = dashboardSource.slice(dashboardSource.indexOf("async function init()"));
  assert.doesNotMatch(initSource, /initBilling\(\)/);
});

test("authenticated dashboard honors billing deep links without onboarding or opening checkout", async () => {
  let gateCalls = 0;
  let billingLoads = 0;
  const opened = [];
  const context = loadFunctions(dashboardSource, ["requestedDashboardPanel", "showDashboard"], {
    window: { location: { href: "https://example.test/dashboard#billing" }, scrollTo() {} },
    $: () => element(), viewAuth: element(), viewDash: element(),
    hide() {}, show() {}, setNavCtaLoggedIn() {}, userHasPasswordProvider: () => false,
    detectApiMode: async () => {}, loadKeys: async () => {}, renderSnippet() {},
    loadSubscription: async () => { billingLoads++; },
    openDashboardPanel: (panel) => opened.push(panel), initBilling() {},
    onboarding: { maybeShow: async () => { gateCalls++; return true; } },
    handleEnablePayg: () => assert.fail("Page view must not open checkout"),
  });
  await context.showDashboard({ email: "customer@product.example.test" }, { isNewUser: true });
  assert.equal(gateCalls, 0);
  assert.equal(billingLoads, 1);
  assert.deepEqual(opened, ["billing"]);
  context.window.location.href = "https://example.test/dashboard";
  await context.showDashboard({ email: "customer@product.example.test" }, { isNewUser: true });
  assert.equal(gateCalls, 1);
  assert.equal(billingLoads, 1);
});

test("checkout uses existing billing actions, explicit auto-recharge and visible failures", async () => {
  const error = element();
  const calls = [];
  const context = loadFunctions(dashboardSource, ["creditLimitsFromSub", "handleEnablePaygCheckout"], {
    apiMode: "remote", lastBillingSub: {}, $: () => error,
    window: { location: {} }, alert: () => assert.fail("Unexpected alert"),
    apiFetch: async (url, options) => { calls.push([url, JSON.parse(options.body)]); return { url: "https://checkout.example/credits" }; },
  });
  await context.handleEnablePaygCheckout(10);
  assert.deepEqual(calls[0], ["/api/billing", { action: "enable_payg", credit_limit_usd: 10, auto_recharge: false, force_topup: false }]);
  assert.equal(context.window.location.href, "https://checkout.example/credits");
  context.lastBillingSub = { credit_wallet: true };
  await context.handleEnablePaygCheckout(10, true);
  assert.equal(calls[1][1].action, "top_up");
  assert.equal(calls[1][1].auto_recharge, true);
  context.apiFetch = async () => ({});
  await context.handleEnablePaygCheckout(10);
  assert.match(error.textContent, /did not return a URL/);
  context.apiFetch = async () => { throw new Error("Checkout unavailable"); };
  await context.handleEnablePaygCheckout(10);
  assert.equal(error.textContent, "Checkout unavailable");
  assert.equal(error.classList.contains("hidden"), false);
});

test("onboarding offers no reward claims and checkout never enables auto-recharge", async () => {
  const calls = [];
  const context = loadFunctions(onboardingSource, ["renderQuests", "claimQuest", "startCheckout", "evaluateShouldOnboard"], {
    state: { bonus_tokens: 30000 }, QUEST_COPY: { star: {}, x_follow: {}, plugin: {} },
    mode: "onboard", render() {}, selectedCheckoutUsd: () => 10,
    CREDIT_MIN_USD: 10, CREDIT_MAX_USD: 1000, checkoutBusy: false, checkoutError: "",
    window: { location: {} }, apiFetch: async (url, options) => {
      calls.push([url, JSON.parse(options.body)]);
      return { url: "https://checkout.example/credits" };
    },
  });
  assert.doesNotMatch(context.renderQuests(), /bonus|10,000|30,000|earn|reward/i);
  await context.claimQuest("star");
  assert.equal(calls.length, 0);
  await context.startCheckout();
  assert.equal(calls[1][0], "/api/billing");
  assert.equal(calls[1][1].auto_recharge, false);
  assert.equal(context.evaluateShouldOnboard({ needs_onboarding: false }, { forceNew: true }), false);
  context.apiFetch = async () => ({});
  await context.startCheckout();
  assert.match(context.checkoutError, /did not return a URL/);
  assert.equal(context.checkoutBusy, false);
  context.apiFetch = async () => { throw new Error("Payment service unavailable"); };
  await context.startCheckout();
  assert.equal(context.checkoutError, "Payment service unavailable");
});

test("released copy and structured data use 1M, retaining history and incidental numbers", () => {
  const root = path.resolve(__dirname, "../..");
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    if (!entry.endsWith(".html") || entry === "changelog.html") continue;
    const html = fs.readFileSync(path.join(root, entry), "utf8");
    assert.doesNotMatch(html, /launch promo|5M (?:free|hosted|tokens)|free (?:tier of )?5M|5,000,000 tokens|earn free tokens/i, entry);
    for (const match of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => JSON.parse(match[1]), entry);
    }
  }
  const html = fs.readFileSync(path.join(root, "dashboard.html"), "utf8");
  assert.match(html, /1M tokens every month/);
  assert.match(html, /min="10"/);
  assert.doesNotMatch(html, /id="credits-auto-recharge" checked/);
  assert.doesNotMatch(dashboardSource, /first_pay_bonus|on the house/);
  assert.doesNotMatch(onboardingSource, /bonus_tokens|onboarding-claim|10,000|30,000|earn free tokens|claim.*free tokens/i);
});
