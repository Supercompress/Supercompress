const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../web/assets/js/dashboard-api.js"), "utf8");
const start = source.indexOf('  $("btn-google").addEventListener("click", async () => {');
const end = source.indexOf('  $("auth-form").addEventListener', start);

function browserHarness(popup, redirect) {
  let click;
  const errors = [];
  const oauth = { state: "state-preserved", code_challenge: "pkce-preserved" };
  const stashed = [];
  const button = { disabled: false, addEventListener(event, handler) { click = handler; } };
  const context = vm.createContext({
    auth: {}, provider: {}, $: () => button,
    setError: (error) => errors.push(error),
    oauthAuthorizeFromUrl: () => oauth,
    stashOauthAuthorize: (value) => stashed.push(value),
    friendlyAuthError: (error) => error.message,
    authErrorCode: (error) => error.code,
    isAuthNetworkError: (error) => error.code === "auth/network-request-failed",
    signInWithPopup: popup, signInWithRedirect: redirect,
  });
  vm.runInContext(source.slice(source.indexOf("function shouldFallbackGoogleRedirect("), source.indexOf("async function getUserToken(")), context);
  vm.runInContext(source.slice(start, end), context);
  return { click, button, errors, stashed, oauth };
}

test("Google fallback failure performs only one redirect and restores the button", async () => {
  let redirects = 0;
  const error = Object.assign(new Error("network unavailable"), { code: "auth/network-request-failed" });
  const harness = browserHarness(async () => { throw error; }, async () => { redirects += 1; throw error; });
  await harness.click();
  assert.equal(redirects, 1);
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.errors.at(-1), error.message);
  assert(harness.stashed.every((value) => value === harness.oauth));
});

test("Closing Google popup does not force a redirect", async () => {
  let redirects = 0;
  const harness = browserHarness(async () => { throw Object.assign(new Error("closed"), { code: "auth/popup-closed-by-user" }); }, async () => { redirects += 1; });
  await harness.click();
  assert.equal(redirects, 0);
  assert.equal(harness.button.disabled, false);
});

test("Concurrent Google clicks start only one authentication attempt", async () => {
  let finish;
  let attempts = 0;
  const harness = browserHarness(() => { attempts += 1; return new Promise((resolve) => { finish = resolve; }); }, async () => {});
  const pending = harness.click();
  await harness.click();
  assert.equal(attempts, 1);
  assert.equal(harness.button.disabled, true);
  finish(null);
  await pending;
  assert.equal(harness.button.disabled, false);
});

test("Dashboard initializes Firebase with the configured OAuth domain on preview and production", async () => {
  for (const hostname of ["www.supercompress.dev", "docs.supercompress.dev", "supercompress-preview.vercel.app"]) {
    let configured;
    const context = vm.createContext({
      cfg: { apiKey: "public-test-key", projectId: "test-project", authDomain: "test-project.firebaseapp.com" },
      window: { location: { hostname } }, hide() {}, show() {}, $() {},
      initializeApp(config) { configured = config; throw new Error("stop-after-init"); },
    });
    vm.runInContext(source.slice(source.indexOf("function cleanConfigValue("), source.indexOf("let cfg =")), context);
    vm.runInContext(source.slice(source.indexOf("async function initFirebaseAuth()"), source.indexOf("function firebaseConfigReady(")), context);
    await assert.rejects(vm.runInContext("initFirebaseAuth()", context), /stop-after-init/);
    assert.equal(configured.authDomain, "test-project.firebaseapp.com");
  }
});
