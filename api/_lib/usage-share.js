/**
 * Scoped, read-only usage share tokens (`scu_…`).
 *
 * A user mints one with their own API key and hands it to a third party
 * (for example the tokenmaxx leaderboard). The token can ONLY read aggregate
 * token counters for the current month. It cannot compress, list keys, read
 * email/uid, or touch billing.
 *
 * Stateless: the token is an HMAC over {owner uid, api key id}. It stays valid
 * while that API key is active, so revoking the key revokes every share token
 * minted from it. Needs SC_USAGE_SHARE_SECRET (>= 32 chars) in the environment.
 */
"use strict";

const crypto = require("crypto");

const PREFIX = "scu_";

function shareSecret() {
  const s = process.env.SC_USAGE_SHARE_SECRET || "";
  if (s.length < 32) {
    const err = new Error("Usage sharing is not configured");
    err.status = 503;
    throw err;
  }
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(payload, secret) {
  return b64url(crypto.createHmac("sha256", secret).update(`usage-share:v1:${payload}`).digest());
}

function mintShareToken(ownerUid, keyId, secret = shareSecret()) {
  if (!ownerUid || !keyId) throw Object.assign(new Error("Missing owner or key"), { status: 400 });
  const payload = b64url(JSON.stringify({ v: 1, u: String(ownerUid), k: String(keyId) }));
  return `${PREFIX}${payload}.${sign(payload, secret)}`;
}

function verifyShareToken(token, secret = shareSecret()) {
  if (typeof token !== "string" || !token.startsWith(PREFIX) || token.length > 600) return null;
  const [payload, sig] = token.slice(PREFIX.length).split(".");
  if (!payload || !sig) return null;
  const want = Buffer.from(sign(payload, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.v !== 1 || !data.u || !data.k) return null;
    return { ownerUid: data.u, keyId: data.k };
  } catch (_) {
    return null;
  }
}

/** Opaque, stable per-account id so readers can dedupe without seeing the uid. */
function accountRef(ownerUid, secret = shareSecret()) {
  return crypto.createHmac("sha256", secret).update(`usage-share:acct:${ownerUid}`).digest("hex").slice(0, 24);
}

const n = (x) => Math.max(0, Number(x) || 0);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Same max(ledger, current-month agent totals) rule as GET /api/keys, numbers only. */
function summarizeUsage(accountUsage, codingAgentUsage, now = new Date()) {
  const month = (accountUsage && accountUsage.month) || now.toISOString().slice(0, 7);
  const agents = {};
  const agentTotals = { requests: 0, tokens_in: 0, tokens_out: 0, tokens_saved: 0 };
  for (const [name, snap] of Object.entries(codingAgentUsage || {})) {
    const row = {
      requests: n(snap?.requests),
      tokens_in: n(snap?.tokens_in),
      tokens_out: n(snap?.tokens_out),
      tokens_saved: n(snap?.tokens_saved),
    };
    agents[String(name).slice(0, 40)] = row;
    for (const k of Object.keys(agentTotals)) agentTotals[k] += row[k];
  }
  const by_day = {};
  for (const [day, rec] of Object.entries(accountUsage?.by_day || {})) {
    if (!ISO_DAY.test(day) || !rec || typeof rec !== "object") continue;
    by_day[day] = {
      requests: n(rec.requests),
      tokens_in: n(rec.tokens_in),
      tokens_out: n(rec.tokens_out),
      tokens_saved: n(rec.tokens_saved),
    };
  }
  const total = (k) => Math.max(n(accountUsage?.[k]), agentTotals[k]);
  return {
    month,
    requests: total("requests"),
    tokens_in: total("tokens_in"),
    tokens_out: total("tokens_out"),
    tokens_saved: total("tokens_saved"),
    by_day,
    agents,
  };
}

module.exports = { PREFIX, mintShareToken, verifyShareToken, accountRef, summarizeUsage, shareSecret };
