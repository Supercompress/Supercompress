const { freeAllowance, isComped, isLegacyMetered } = require("./stripe");
const { firstNameFromUser } = require("./power-user");
const { QUOTA_MAIL_CLAIM, quotaIdempotencyKey } = require("./quota-mail");

const POWER_QUOTA_MAIL_CLAIM = "sc_power_quota_mail";

function powerQuotaCandidate(user, month) {
  if (!user || user.disabled || /^(sck_|sc_lnk_|sc_at_|sc_ac_|sc_aff_|sc_fnl_)/.test(user.uid || "")) return null;
  const email = String(user.email || "").trim().toLowerCase();
  if (!email.includes("@") || /noreply|@example\.com$|\.example$|sc\.test\./i.test(email)) return null;
  const claims = user.customClaims || {};
  if (claims.sc_unsub || isComped(claims) || isLegacyMetered(claims) || Number(claims.sc_credit_balance_usd || 0) > 0) return null;
  if (claims[POWER_QUOTA_MAIL_CLAIM] === month || claims.sc_quota_mail === month) return null;
  const usage = claims.sc_usage || {};
  if (claims.sc_power_mail !== "sent" && Number(usage.tokens_in || 0) < 1_000_000) return null;
  return {
    email,
    firstName: firstNameFromUser(user),
    tokensUsed: usage.month === month ? Math.max(0, Number(usage.tokens_in) || 0) : 0,
    freeTokens: freeAllowance(claims),
    month,
    idempotencyKey: quotaIdempotencyKey(user.uid, month),
  };
}

function createPowerQuotaRunner({ getAuth, send, stamp, getUnsubscribes, isBlocked, unsubscribeLinks, now = () => new Date() }) {
  return async function run({ cap = 80, dryRun = true } = {}) {
    if (!Number.isInteger(cap) || cap < 1 || cap > 80) throw new Error("invalid_mail_cap");
    if (typeof dryRun !== "boolean") throw new Error("invalid_dry_run");
    const month = now().toISOString().slice(0, 7);
    const auth = await getAuth();
    const unsubscribes = await getUnsubscribes();
    const result = { month, scanned: 0, eligible: 0, sent: 0, failed: 0, dry_run: dryRun };
    let pageToken;
    do {
      const page = await auth.listUsers(1000, pageToken);
      for (const listed of page.users) {
        result.scanned += 1;
        if (!powerQuotaCandidate(listed, month)) continue;
        const user = await auth.getUser(listed.uid);
        const candidate = powerQuotaCandidate(user, month);
        if (!candidate) continue;
        const suppressed = unsubscribes instanceof Set
          ? unsubscribes.has(require("node:crypto").createHash("sha256").update(candidate.email).digest("hex"))
          : unsubscribes[candidate.email];
        if (suppressed || isBlocked({ email: candidate.email, first_name: candidate.firstName })) continue;
        result.eligible += 1;
        if (dryRun) continue;
        const delivery = await send({ ...candidate, ...unsubscribeLinks(candidate.email) });
        if (!delivery.ok) {
          result.failed += 1;
          result.error = "mail_delivery_failed";
          return result;
        }
        result.sent += 1;
        if (!await stamp(user.uid, QUOTA_MAIL_CLAIM, month)) {
          result.failed += 1;
          result.error = "mail_sent_but_stamp_failed";
          return result;
        }
        if (result.sent >= cap) return result;
      }
      pageToken = page.pageToken;
    } while (pageToken);
    return result;
  };
}

async function drainPowerQuotaMails(options) {
  const admin = require("firebase-admin");
  const { initFirebaseAdmin } = require("./auth");
  const { stampOwnerClaim } = require("./billing-ledger");
  const { isHardBlockedRecipient, unsubUrlFor, unsubApiUrlFor } = require("./weekly");
  const { sendQuotaExhaustedEmail } = require("./mail");
  if (!initFirebaseAdmin()) return { sent: 0, error: "no_admin" };
  return createPowerQuotaRunner({
    getAuth: () => admin.auth(),
    send: sendQuotaExhaustedEmail,
    stamp: stampOwnerClaim,
    getUnsubscribes: async () => {
      return require("./mail-suppressions").reconciledMailSuppressions();
    },
    isBlocked: user => isHardBlockedRecipient(user) || /nikunj|kothari/i.test(`${user.email || ""} ${user.first_name || ""}`),
    unsubscribeLinks: email => ({ unsubUrl: unsubUrlFor(email), listUnsubscribeUrl: unsubApiUrlFor(email) }),
  })(options);
}

module.exports = { POWER_QUOTA_MAIL_CLAIM, powerQuotaCandidate, createPowerQuotaRunner, drainPowerQuotaMails };
