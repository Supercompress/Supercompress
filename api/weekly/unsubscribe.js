/**
 * Public one-click unsubscribe alias used in weekly email List-Unsubscribe /
 * HTML links: POST|GET /api/weekly/unsubscribe?email=&token=
 *
 * Delegates to api/account.js?op=weekly-unsubscribe (token required).
 */
module.exports = async (req, res) => {
  if (!req.query || typeof req.query !== "object") req.query = {};
  req.query.op = "weekly-unsubscribe";
  return require("../account")(req, res);
};
