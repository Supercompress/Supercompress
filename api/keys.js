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
      return json(res, 200, { ...keys, coding_agent_usage, agent_plugin });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const name = (body.name || "Production").trim().slice(0, 80) || "Production";
      const owner = await require("firebase-admin").auth().getUser(user.uid);
      const planId = owner.customClaims?.sc_plan || "free";
      const plan = getPlan(planId);
      return json(res, 200, await createKey(user.uid, name, plan.max_keys));
    }

    return json(res, 405, { detail: "Method not allowed" });
  } catch (err) {
    return json(res, err.status || 500, { detail: err.message });
  }
};
