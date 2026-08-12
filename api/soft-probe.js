/**
 * Catch-all soft probe for scanner paths rewritten here (wp-login, .env, etc.).
 * Always 200 so Vercel Observability error rate ignores bot noise.
 */
const { softProbe } = require("./_lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  return softProbe(res, "Not found", { path: req.url || null });
};
