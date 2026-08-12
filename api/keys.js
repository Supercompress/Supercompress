const { json } = require("./_lib/http");
const { verifyUser } = require("./_lib/auth");
const { getPlan } = require("./_lib/stripe");
const { listKeys, createKey } = require("./_lib/firebase-key-store");
const { loadCodingAgentUsage, loadAgentPluginLink } = require("./_lib/store");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  try {
    const user = await verifyUser(req);

    if (req.method === "GET") {
      const keys = await listKeys(user.uid);
      let coding_agent_usage = {};
      let agent_plugin = { linked: false };
      try {
        coding_agent_usage = await loadCodingAgentUsage(user.uid);
      } catch (_) {}
      try {
        agent_plugin = await loadAgentPluginLink(user.uid);
      } catch (_) {}
      // Prefer max(ledger/claims, *current-month* coding-agent totals) so analytics
      // KPIs never under-report when the billing ledger lags agent metering —
      // and never stamp lifetime agent counters onto the new month.
      let account_usage = keys.account_usage || null;
      const agentTotals = Object.values(coding_agent_usage || {}).reduce(
        (acc, snap) => ({
          requests: acc.requests + (snap.requests || 0),
          tokens_in: acc.tokens_in + (snap.tokens_in || 0),
          tokens_out: acc.tokens_out + (snap.tokens_out || 0),
          tokens_saved: acc.tokens_saved + (snap.tokens_saved || 0),
        }),
        { requests: 0, tokens_in: 0, tokens_out: 0, tokens_saved: 0 }
      );
      if (agentTotals.tokens_in > 0 || agentTotals.requests > 0) {
        const month = new Date().toISOString().slice(0, 7);
        account_usage = {
          month: (account_usage && account_usage.month) || month,
          requests: Math.max(Number(account_usage?.requests || 0), agentTotals.requests),
          tokens_in: Math.max(Number(account_usage?.tokens_in || 0), agentTotals.tokens_in),
          tokens_out: Math.max(Number(account_usage?.tokens_out || 0), agentTotals.tokens_out),
          tokens_saved: Math.max(Number(account_usage?.tokens_saved || 0), agentTotals.tokens_saved),
        };
      }
      return json(res, 200, { ...keys, account_usage, coding_agent_usage, agent_plugin });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const name = (body.name || "Production").trim().slice(0, 80) || "Production";
      const owner = await require("firebase-admin").auth().getUser(user.uid);
      const planId = owner.customClaims?.sc_plan || "free";
      const plan = getPlan(planId);
      return json(res, 200, await createKey(user.uid, name, plan.max_keys));
    }

    return json(res, 405, { detail: "Method not allowed", allow: "GET, POST" });
  } catch (err) {
    const status = err.status || 500;
    return json(res, status, { detail: err.message });
  }
};
