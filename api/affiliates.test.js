/**
 * Affiliate API: referral claims create commission records, so they must be
 * authenticated, non-self, deduplicated, and the founder admin view must stay
 * gated. Store and Firebase auth are in-memory stubs.
 * Run: node api/affiliates.test.js
 */
const assert = require("assert");
const Module = require("module");

process.env.FOUNDER_ADMIN_EMAILS = " Founder@Example.com ,ops@example.com";
process.env.FOUNDER_ADMIN_UIDS = "uid_founder_only";

let store = {};
const clone = (v) => JSON.parse(JSON.stringify(v));
const fakeStore = {
  loadStore: async () => clone(store),
  mutateStore: async (fn) => {
    const next = clone(store);
    await fn(next);
    store = next;
    return next;
  },
};

// Bearer token -> user; anything else fails like Firebase verification does.
const users = {
  "tok-alice": { uid: "uid_alice", email: "alice@example.com" },
  "tok-aff": { uid: "uid_aff", email: "Partner@Example.com" },
  "tok-founder": { uid: "uid_x", email: "founder@example.com" },
  "tok-founder-uid": { uid: "uid_founder_only", email: "someone@example.com" },
  "tok-noemail": { uid: "uid_noemail" },
};
const fakeAuth = {
  verifyUser: async (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    const user = m && users[m[1]];
    if (!user) throw Object.assign(new Error("Unauthorized"), { status: 401 });
    return user;
  },
};
const fakeRateLimit = { checkDurableRateLimit: async () => ({ allowed: true, remaining: 29, resetMs: 0, limit: 30 }) };

const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "./_lib/store") return fakeStore;
  if (request === "./_lib/auth") return fakeAuth;
  if (request === "./_lib/rate-limit-durable") return fakeRateLimit;
  return realLoad.call(this, request, ...rest);
};

const handler = require("./affiliates");
const { isFounderEmail, isFounderUser } = require("./_lib/founder");

function makeRes() {
  const res = { statusCode: null, body: undefined, headers: {} };
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v;
  };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  res.end = () => res;
  return res;
}

async function call({ method = "POST", token, body, query, url = "/api/affiliates" } = {}) {
  const headers = { "x-forwarded-for": "203.0.113.9" };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = { method, headers, body, query, url, socket: {} };
  const res = makeRes();
  await handler(req, res);
  return res;
}

function seed() {
  store = {
    affiliates: {
      aff_1: {
        id: "aff_1",
        name: "Partner",
        email: "partner@example.com",
        referral_slug: "partner",
        referral_link: "https://supercompress.dev/?ref=partner",
        status: "active",
        paypal_email: "pay@example.com",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      aff_2: {
        id: "aff_2",
        name: "Dormant",
        email: "dormant@example.com",
        referral_slug: "dormant",
        status: "inactive",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    },
    affiliate_conversions: {},
  };
}

const conversions = () => Object.values(store.affiliate_conversions || {});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ── founder allowlist ── */

test("founder allowlist is env-driven, case/whitespace-insensitive for emails", () => {
  assert.strictEqual(isFounderEmail("founder@example.com"), true);
  assert.strictEqual(isFounderEmail("  OPS@EXAMPLE.COM "), true);
  assert.strictEqual(isFounderEmail("founder@example.com.evil"), false);
  assert.strictEqual(isFounderEmail(""), false);
  assert.strictEqual(isFounderEmail(undefined), false);
  assert.strictEqual(isFounderUser({ uid: "uid_founder_only", email: "x@y.z" }), true);
  assert.strictEqual(isFounderUser({ uid: "UID_FOUNDER_ONLY" }), false, "uids are exact-match");
  assert.strictEqual(isFounderUser({}), false);
  assert.strictEqual(isFounderUser(), false);
});

test("founder allowlist with no env configured grants nobody", () => {
  const saved = { e: process.env.FOUNDER_ADMIN_EMAILS, u: process.env.FOUNDER_ADMIN_UIDS };
  const path = require.resolve("./_lib/founder");
  const cached = require.cache[path];
  delete process.env.FOUNDER_ADMIN_EMAILS;
  delete process.env.FOUNDER_ADMIN_UIDS;
  delete require.cache[path];
  try {
    const fresh = require("./_lib/founder");
    assert.strictEqual(fresh.isFounderEmail(""), false);
    assert.strictEqual(fresh.isFounderUser({ uid: "", email: "" }), false);
    assert.strictEqual(fresh.isFounderUser({ uid: "uid_founder_only", email: "founder@example.com" }), false);
  } finally {
    process.env.FOUNDER_ADMIN_EMAILS = saved.e;
    process.env.FOUNDER_ADMIN_UIDS = saved.u;
    require.cache[path] = cached;
  }
});

/* ── claim ── */

test("claim without a valid sign-in is 401 and stores nothing", async () => {
  const anon = await call({ body: { action: "claim", ref: "partner", user_email: "victim@example.com" } });
  assert.strictEqual(anon.statusCode, 401);
  const bad = await call({ token: "forged", body: { action: "claim", ref: "partner" } });
  assert.strictEqual(bad.statusCode, 401);
  assert.strictEqual(conversions().length, 0);
});

test("signed-in claim records one pending 40% conversion for the account email", async () => {
  const res = await call({ token: "tok-alice", body: { action: "claim", ref: " PARTNER " } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.claimed, true);
  assert.strictEqual(res.body.commission_pct, 40);
  const [conv] = conversions();
  assert.strictEqual(conversions().length, 1);
  assert.strictEqual(conv.ref, "partner");
  assert.strictEqual(conv.user_email, "alice@example.com");
  assert.strictEqual(conv.user_id, "uid_alice");
  assert.strictEqual(conv.status, "pending");
  assert.strictEqual(conv.affiliate_email, "partner@example.com");
});

test("claiming on behalf of a different email is forbidden", async () => {
  const res = await call({ token: "tok-alice", body: { action: "claim", ref: "partner", user_email: "someone-else@example.com" } });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(conversions().length, 0);
});

test("account without an email cannot claim without supplying one", async () => {
  const res = await call({ token: "tok-noemail", body: { action: "claim", ref: "partner" } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(conversions().length, 0);
});

test("self-referral is rejected regardless of email casing", async () => {
  const res = await call({ token: "tok-aff", body: { action: "claim", ref: "partner" } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.detail, /own referral/);
  assert.strictEqual(conversions().length, 0);
});

test("inactive or unknown affiliates cannot receive claims", async () => {
  assert.strictEqual((await call({ token: "tok-alice", body: { action: "claim", ref: "dormant" } })).statusCode, 404);
  assert.strictEqual((await call({ token: "tok-alice", body: { action: "claim", ref: "nobody" } })).statusCode, 404);
  assert.strictEqual(conversions().length, 0);
});

test("repeat claims by the same account are deduplicated", async () => {
  await call({ token: "tok-alice", body: { action: "claim", ref: "partner" } });
  const again = await call({ token: "tok-alice", body: { action: "claim", ref: "partner" } });
  assert.strictEqual(again.statusCode, 200);
  assert.strictEqual(again.body.duplicate, true);
  assert.strictEqual(conversions().length, 1);
});

/* ── read views ── */

test("public list omits affiliate PII", async () => {
  const res = await call({ method: "GET", query: {} });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.affiliates.length, 2);
  for (const a of res.body.affiliates) {
    assert.strictEqual(a.email, undefined);
    assert.strictEqual(a.paypal_email, undefined);
  }
});

test("admin view requires auth and founder status", async () => {
  assert.strictEqual((await call({ method: "GET", query: { view: "admin" } })).statusCode, 401);
  const nonFounder = await call({ method: "GET", token: "tok-alice", query: { view: "admin" } });
  assert.strictEqual(nonFounder.statusCode, 403);
  assert.strictEqual(nonFounder.body.affiliates, undefined);
  const viaUrl = await call({ method: "GET", token: "tok-alice", url: "/api/affiliates?view=admin" });
  assert.strictEqual(viaUrl.statusCode, 403);
});

test("founder admin view totals payouts at $8.00 per conversion", async () => {
  store.affiliate_conversions = {
    c1: { ref: "partner", status: "pending", created_at: "2026-02-01T00:00:00Z" },
    c2: { ref: "partner", status: "pending", created_at: "2026-02-02T00:00:00Z" },
    c3: { ref: "partner", status: "confirmed", created_at: "2026-02-03T00:00:00Z" },
    c4: { ref: "dormant", status: "pending", created_at: "2026-02-04T00:00:00Z" },
  };
  for (const token of ["tok-founder", "tok-founder-uid"]) {
    const res = await call({ method: "GET", token, query: { view: "admin" } });
    assert.strictEqual(res.statusCode, 200, token);
    assert.strictEqual(res.body.summary.total_conversions, 4);
    assert.strictEqual(res.body.summary.pending_payout_cents, 2400);
    assert.strictEqual(res.body.summary.paid_out_cents, 800);
    assert.strictEqual(res.body.summary.pending_payout_dollars, "24.00");
    const partner = res.body.affiliates.find((a) => a.id === "aff_1");
    assert.strictEqual(partner.stats.pending_payout_cents, 1600);
    assert.strictEqual(partner.stats.paid_out_dollars, "8.00");
  }
});

test("me view returns only the caller's own affiliate record", async () => {
  assert.strictEqual((await call({ method: "GET", query: { view: "me" } })).statusCode, 401);
  const none = await call({ method: "GET", token: "tok-alice", query: { view: "me" } });
  assert.strictEqual(none.statusCode, 404);
  store.affiliates.aff_1.uid = "uid_aff";
  const mine = await call({ method: "GET", token: "tok-aff", query: { view: "me" } });
  assert.strictEqual(mine.statusCode, 200);
  assert.strictEqual(mine.body.affiliate.id, "aff_1");
  assert.strictEqual(mine.body.is_founder, false);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    seed();
    try {
      await t.fn();
      console.log(`ok - ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL - ${t.name}\n`, err);
    }
  }
  Module._load = realLoad;
  if (failed) {
    console.error(`${failed} affiliates test(s) failed`);
    process.exit(1);
  }
  console.log(`affiliates: ${tests.length} tests passed`);
})();
