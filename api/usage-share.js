/**
 * /api/usage-share — opt-in, read-only usage sharing.
 *
 *   POST  (X-API-Key: sc_… or Authorization: Bearer sc_…)  → mint a `scu_` token
 *   GET   (Authorization: Bearer scu_…)                    → current-month counters
 *
 * GET never returns email, uid, key names or prompts. Revoke by revoking the
 * API key the token was minted from.
 */
"use strict";

const { json } = require("./_lib/http");
const { authenticateKey, listKeys } = require("./_lib/firebase-key-store");
const { loadCodingAgentUsage } = require("./_lib/store");
const { PREFIX, mintShareToken, verifyShareToken, accountRef, summarizeUsage } = require("./_lib/usage-share");

function bearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : "";
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    if (req.method === "POST") {
      const key = String(req.headers?.["x-api-key"] || bearer(req) || "").trim();
      if (!key || key.startsWith(PREFIX)) return json(res, 401, { detail: "Send your SuperCompress API key to mint a share token" });
      const authed = await authenticateKey(key);
      if (!authed || !authed.ownerUid || !authed.keyId) return json(res, 401, { detail: "Invalid API key" });
      return json(res, 200, {
        token: mintShareToken(authed.ownerUid, authed.keyId),
        scope: "usage:read",
        account: accountRef(authed.ownerUid),
        revoke: "Revoke the API key this token was minted from",
      });
    }

    if (req.method === "GET") {
      const parsed = verifyShareToken(bearer(req));
      if (!parsed) return json(res, 401, { detail: "Invalid share token" });
      const keys = await listKeys(parsed.ownerUid);
      const active = (keys?.keys || []).some((k) => k.id === parsed.keyId && !k.revoked);
      if (!active) return json(res, 401, { detail: "Share token revoked" });
      let agents = {};
      try {
        agents = await loadCodingAgentUsage(parsed.ownerUid);
      } catch (_) {}
      return json(res, 200, {
        account: accountRef(parsed.ownerUid),
        usage: summarizeUsage(keys.account_usage || null, agents),
      });
    }

    return json(res, 405, { detail: "Method not allowed", allow: "GET, POST" });
  } catch (err) {
    return json(res, err.status || 500, { detail: err.status ? err.message : "Usage share failed" });
  }
};
