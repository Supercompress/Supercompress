const { json, softProbe, hasAuthCredentials } = require("./_lib/http");
const { verifyUser } = require("./_lib/auth");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "GET") {
    return softProbe(res, "Method not allowed", { allow: "GET" });
  }
  try {
    const user = await verifyUser(req);
    return json(res, 200, { uid: user.uid, email: user.email });
  } catch (err) {
    const status = err.status || 401;
    if (status === 401 && !hasAuthCredentials(req)) {
      return softProbe(res, err.message || "Authorization required", { auth: "required" });
    }
    return json(res, status, { detail: err.message });
  }
};
