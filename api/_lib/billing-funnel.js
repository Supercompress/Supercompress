const crypto = require("node:crypto");
const admin = require("firebase-admin");
const { initFirebaseAdmin } = require("./auth");

const STAGES = Object.freeze([
  "quota_blocked", "billing_opened", "checkout_created", "payment_succeeded",
]);
const PREFIX = "sc_fnl_";

function markerId(uid, month, stage) {
  return PREFIX + crypto.createHash("sha256").update(JSON.stringify([uid, month, stage])).digest("hex");
}

function createFunnelTracker({ getAuth, now = () => new Date(), warn = console.warn, timeoutMs = 1500 }) {
  const recorded = new Set();
  async function bounded(operation, fallback) {
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            warn("Billing funnel operation timed out");
            resolve(fallback);
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      warn("Billing funnel operation unavailable:", err.code || "unknown");
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }
  async function read(uid, stage, month = now().toISOString().slice(0, 7)) {
    if (!uid || !STAGES.includes(stage)) return null;
    try {
      const user = await getAuth().getUser(markerId(uid, month, stage));
      const event = user.customClaims?.sc_funnel;
      return user.disabled && event?.uid === uid && event.month === month && event.stage === stage
        ? { ...event, at: user.metadata.creationTime }
        : null;
    } catch (err) {
      if (err.code !== "auth/user-not-found") warn("Billing funnel read unavailable:", err.code || "unknown");
      return null;
    }
  }

  async function record(uid, stage, occurredAt = now()) {
    if (typeof uid !== "string" || !uid || uid.length > 128 || !STAGES.includes(stage)) return false;
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) return false;
    const month = occurredAt.toISOString().slice(0, 7);
    const id = markerId(uid, month, stage);
    if (recorded.has(id)) return true;
    try {
      const auth = getAuth();
      let user;
      try {
        user = await auth.getUser(id);
      } catch (err) {
        if (err.code !== "auth/user-not-found") throw err;
        try {
          user = await auth.createUser({ uid: id, disabled: true, displayName: "SuperCompress billing funnel" });
        } catch (createErr) {
          if (createErr.code !== "auth/uid-already-exists") throw createErr;
          user = await auth.getUser(id);
        }
      }
      if (!user.disabled || user.email) throw new Error("invalid_funnel_marker");
      if (!user.customClaims?.sc_funnel) {
        await auth.setCustomUserClaims(id, { sc_funnel: { uid, month, stage } });
      } else {
        const event = user.customClaims.sc_funnel;
        if (event.uid !== uid || event.month !== month || event.stage !== stage) {
          throw new Error("invalid_funnel_marker");
        }
      }
      if (recorded.size >= 1000) recorded.clear();
      recorded.add(id);
      return true;
    } catch (err) {
      warn("Billing funnel write unavailable:", err.code || "unknown");
      return false;
    }
  }

  async function recordPayment(session, eventCreated) {
    const { paidCreditUsdFromSession, isCreditablePaidUsd } = require("./credit-amount");
    if (session?.payment_status !== "paid" || !session.metadata?.kind?.startsWith("credit_")) return false;
    if (!isCreditablePaidUsd(paidCreditUsdFromSession(session))) return false;
    if (!Number.isFinite(eventCreated) || eventCreated <= 0) return false;
    return record(session.metadata.user_id, "payment_succeeded", new Date(eventCreated * 1000));
  }

  return {
    read: (...args) => bounded(() => read(...args), null),
    record: (...args) => bounded(() => record(...args), false),
    recordPayment: (...args) => bounded(() => recordPayment(...args), false),
  };
}

function summarizeFunnel(users, month) {
  const stages = Object.fromEntries(STAGES.map((stage) => [stage, new Set()]));
  for (const user of users) {
    const event = user.customClaims?.sc_funnel;
    if (!user.disabled || typeof event?.uid !== "string" || event.month !== month || !STAGES.includes(event.stage)) continue;
    if (user.uid !== markerId(event.uid, event.month, event.stage)) continue;
    stages[event.stage].add(event.uid);
  }
  const blocked = stages.quota_blocked;
  return {
    month,
    unique_accounts: Object.fromEntries(STAGES.map((stage) => [stage, stages[stage].size])),
    blocked_cohort: Object.fromEntries(STAGES.map((stage) => [
      stage, [...blocked].filter((uid) => stages[stage].has(uid)).length,
    ])),
    measurement: "Unique accounts per UTC month; stages observed since instrumentation, not ordered events or historical backfill.",
  };
}

const tracker = createFunnelTracker({
  getAuth() {
    if (!initFirebaseAdmin()) throw new Error("firebase_unavailable");
    return admin.auth();
  },
});

module.exports = { STAGES, markerId, createFunnelTracker, summarizeFunnel, ...tracker };
