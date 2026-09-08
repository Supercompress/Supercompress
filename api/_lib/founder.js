/** Shared founder-admin allowlist — env only, no hardcoded identities. */

const FOUNDER_EMAILS = new Set(
  String(process.env.FOUNDER_ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const FOUNDER_UIDS = new Set(
  String(process.env.FOUNDER_ADMIN_UIDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function isFounderEmail(email) {
  if (!FOUNDER_EMAILS.size) return false;
  return FOUNDER_EMAILS.has(String(email || "").toLowerCase().trim());
}

function isFounderUser(user = {}) {
  const uid = String(user.uid || "").trim();
  if (uid && FOUNDER_UIDS.has(uid)) return true;
  return isFounderEmail(user.email);
}

module.exports = { FOUNDER_EMAILS, FOUNDER_UIDS, isFounderEmail, isFounderUser };
