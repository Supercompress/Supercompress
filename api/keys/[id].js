const { json, softProbe, hasAuthCredentials } = require("../_lib/http");
const { verifyUser } = require("../_lib/auth");
const {
  getOwnedKey,
  renameKey,
  revokeKey,
  publicKey,
  usageSnapshot,
} = require("../_lib/firebase-key-store");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  const keyId = req.query?.id;
  if (!keyId) return softProbe(res, "Key id required");

  try {
    const user = await verifyUser(req);

    if (req.method === "GET") {
      const key = await getOwnedKey(user.uid, keyId);
      const { loadStore } = require("../_lib/store");
      const store = await loadStore();
      return json(res, 200, usageSnapshot(key, store));
    }

    if (req.method === "PATCH") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const name = (body.name || "").trim();
      if (!name) return json(res, 422, { detail: "Name required" });
      return json(res, 200, publicKey(await renameKey(user.uid, keyId, name)));
    }

    if (req.method === "DELETE") {
      await revokeKey(user.uid, keyId);
      return json(res, 200, { revoked: true });
    }

    return softProbe(res, "Method not allowed", { allow: "GET, PATCH, DELETE" });
  } catch (err) {
    const status = err.status || 500;
    if (status === 401 && !hasAuthCredentials(req)) {
      return softProbe(res, err.message || "Authorization required", { auth: "required" });
    }
    return json(res, status, { detail: err.message });
  }
};
