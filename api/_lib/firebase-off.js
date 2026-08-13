/**
 * Cloud Firestore is disabled on this project (API never enabled).
 * Default: skip every Firestore probe so compress/billing/mail do not pay
 * 1.2s timeouts or 403 gist fallbacks on the hot path.
 *
 * Opt back in with SUPERCOMPRESS_USE_FIRESTORE=1 after the API is enabled.
 */
function skipFirestore() {
  const v = String(process.env.SUPERCOMPRESS_USE_FIRESTORE || "").trim().toLowerCase();
  return !(v === "1" || v === "true" || v === "yes");
}

module.exports = { skipFirestore };
