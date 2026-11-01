const crypto = require("node:crypto");
const { powerQuotaCandidate } = require("./power-quota-mail");
const { quotaMailAlreadySent, QUOTA_MAIL_CLAIM } = require("./quota-mail");

const CONVERSION_CLAIM = "sc_conv";
const DAY_SECONDS = 86400;
const FOLLOWUP_DAYS = [0, 3, 7];

function hasPaidHistory(claims = {}) {
  return Boolean(claims.sc_subscription_id || claims.sc_first_pay_bonus_at ||
    (Array.isArray(claims.sc_credited_sessions) && claims.sc_credited_sessions.length) ||
    (Array.isArray(claims.sc_recent_billing) && claims.sc_recent_billing.some(row => Number(row.credit_usd || row.amount_usd || 0) > 0)));
}

function validState(state) {
  return Array.isArray(state) && state.length === 5 && state[0] === 1 &&
    Number.isInteger(state[1]) && state[1] >= 0 && state[1] <= 2 &&
    Number.isInteger(state[2]) && state[2] > 0 &&
    Number.isInteger(state[3]) && state[3] >= state[2] &&
    ["pending", "sent"].includes(state[4]);
}

function conversionCandidate(user, date = new Date(), paidUserIds = new Set()) {
  if (paidUserIds.has(user?.uid)) return null;
  const claims = user?.customClaims || {};
  if (hasPaidHistory(claims)) return null;
  const month = date.toISOString().slice(0, 7);
  const candidate = powerQuotaCandidate({ ...user, customClaims: {
    ...claims, sc_quota_mail: null, sc_power_quota_mail: null,
  } }, month);
  if (!candidate) return null;
  const now = Math.floor(date.getTime() / 1000);
  const state = claims[CONVERSION_CLAIM];
  if (state !== undefined && !validState(state)) return null;
  if (!state) {
    const action = quotaMailAlreadySent(claims, month) ? "seed" : "send";
    return { ...candidate, action, stage: 0, state: [1, 0, now, now, action === "seed" ? "sent" : "pending"] };
  }
  if (state[4] !== "sent" || state[1] === 2 || now < state[3] || now - state[3] < 3 * DAY_SECONDS) return null;
  const stage = state[1] + 1;
  if (now - state[2] < FOLLOWUP_DAYS[stage] * DAY_SECONDS) return null;
  return {
    ...candidate, action: "send", stage, state: [1, stage, state[2], now, "pending"],
    idempotencyKey: `conversion-${crypto.createHash("sha256").update(JSON.stringify([user.uid, state[2], stage])).digest("hex")}`,
  };
}

function createConversionRunner({ getAuth, getUnsubscribes, getPaidUserIds, getState = async user => user.customClaims?.[CONVERSION_CLAIM], isBlocked, unsubscribeLinks, reserve, complete, send, now = () => new Date() }) {
  return async function run({ dryRun = true, cap = 40 } = {}) {
    if (typeof dryRun !== "boolean" || !Number.isInteger(cap) || cap < 1 || cap > 80) throw Error("invalid_conversion_options");
    const date = now();
    const auth = await getAuth();
    const unsubscribes = await getUnsubscribes();
    const paidUserIds = await getPaidUserIds(auth);
    const result = { dry_run: dryRun, scanned: 0, eligible: 0, due_initial: 0, due_followup: 0, due_seed: 0, seeded: 0, sent: 0, failed: 0, pending_review: 0 };
    let pageToken;
    do {
      const page = await auth.listUsers(1000, pageToken);
      for (let listed of page.users) {
        result.scanned += 1;
        if (listed.customClaims?.[CONVERSION_CLAIM] === undefined && !conversionCandidate(listed, date, paidUserIds)) continue;
        listed = { ...listed, customClaims: { ...listed.customClaims, [CONVERSION_CLAIM]: await getState(listed) } };
        if (listed.customClaims?.[CONVERSION_CLAIM]?.[4] === "pending") result.pending_review += 1;
        if (!conversionCandidate(listed, date, paidUserIds)) continue;
        const live = await auth.getUser(listed.uid);
        const user = { ...live, customClaims: { ...live.customClaims, [CONVERSION_CLAIM]: await getState(live) } };
        const candidate = conversionCandidate(user, date, paidUserIds);
        if (!candidate || unsubscribes.has(crypto.createHash("sha256").update(candidate.email).digest("hex")) ||
            user.customClaims?.sc_unsub || isBlocked({ email: candidate.email, first_name: user.displayName || candidate.firstName })) continue;
        result.eligible += 1;
        if (candidate.action === "seed") result.due_seed += 1;
        else if (candidate.stage === 0) result.due_initial += 1;
        else result.due_followup += 1;
        if (dryRun) continue;
        if (candidate.action === "seed") {
          if (!await reserve(user, candidate)) return { ...result, failed: 1, error: "seed_failed" };
          result.seeded += 1;
          continue;
        }
        if (!await reserve(user, candidate)) return { ...result, failed: 1, error: "reservation_failed" };
        const refreshed = await auth.getUser(user.uid);
        if (refreshed.customClaims?.sc_unsub || hasPaidHistory(refreshed.customClaims) ||
            !powerQuotaCandidate({ ...refreshed, customClaims: { ...refreshed.customClaims, sc_quota_mail: null, sc_power_quota_mail: null } }, candidate.month)) {
          result.pending_review += 1;
          continue;
        }
        const receipt = await send({ ...candidate, followupStage: candidate.stage, ...unsubscribeLinks(candidate.email) });
        if (!receipt?.ok) return { ...result, failed: 1, error: "delivery_failed_pending_review" };
        result.sent += 1;
        if (!await complete(user, candidate)) return { ...result, failed: 1, error: "completion_failed_pending_review" };
        if (result.sent >= cap) return result;
      }
      pageToken = page.pageToken;
    } while (pageToken);
    return result;
  };
}

async function drainConversionMails(options = {}) {
  const { initFirebaseAdmin } = require("./auth");
  const admin = require("firebase-admin");
  const { patchUserClaims, claimsByteLength, AUTH_CLAIMS_MAX_BYTES } = require("./billing-ledger");
  const { isHardBlockedRecipient, unsubUrlFor, unsubApiUrlFor } = require("./weekly");
  const { sendQuotaExhaustedEmail } = require("./mail");
  if (!initFirebaseAdmin()) throw Error("conversion_auth_unavailable");
  if (options.dryRun === false && process.env.SC_CONVERSION_EMAILS_ENABLED !== "1") throw Error("conversion_disabled");
  if (options.dryRun === false && !process.env.RESEND_API_KEY?.trim()) throw Error("conversion_sender_unavailable");
  if (!process.env.WELCOME_DRAIN_SECRET?.trim()) throw Error("unsubscribe_signing_key_missing");
  if (!process.env.SC_CONVERSION_STATE_DB) throw Error("conversion_state_path_missing");
  const storage = createSqliteStorage(process.env.SC_CONVERSION_STATE_DB);
  const stateStore = createConversionStateStore({ storage, getUser: uid => admin.auth().getUser(uid) });
  const writeState = async (user, candidate, delivered) => {
    try {
      if (delivered && candidate.stage === 0) {
        await patchUserClaims(user.uid, live => {
          const next = { ...live, [QUOTA_MAIL_CLAIM]: candidate.month };
          if (claimsByteLength({ ...next, sc_write_id: "000000000000" }) > AUTH_CLAIMS_MAX_BYTES) throw Error("conversion_claims_budget_exceeded");
          return next;
        }, {
          verify: after => after[QUOTA_MAIL_CLAIM] === candidate.month,
        });
      }
      return await stateStore.write(user, candidate, delivered);
    } catch (_) {
      return false;
    }
  };
  return createConversionRunner({
    getAuth: () => admin.auth(),
    getState: stateStore.read,
    getUnsubscribes: async () => {
      return require("./mail-suppressions").reconciledMailSuppressions();
    },
    getPaidUserIds: paidUserIdsFromStripe,
    isBlocked: recipient => isHardBlockedRecipient(recipient) || /nikunj|kothari/i.test(recipient.email + " " + recipient.first_name),
    unsubscribeLinks: email => ({ unsubUrl: unsubUrlFor(email), listUnsubscribeUrl: unsubApiUrlFor(email) }),
    reserve: (user, candidate) => writeState(user, candidate, false),
    complete: (user, candidate) => writeState(user, candidate, true),
    send: sendQuotaExhaustedEmail,
  })(options);
}

function createConversionStateStore({ storage, getUser }) {
  const keyFor = uid => crypto.createHash("sha256").update(uid).digest("hex");
  return {
    read: async user => {
      const state = await storage.read(keyFor(user.uid));
      if (state !== undefined && !validState(state)) throw Error("conversion_state_invalid");
      return state === undefined ? user.customClaims?.[CONVERSION_CLAIM] : state;
    },
    write: async (user, candidate, delivered) => {
      const live = await getUser(user.uid);
      if (live.customClaims?.sc_unsub || hasPaidHistory(live.customClaims)) return false;
      const expected = delivered ? candidate.state : user.customClaims?.[CONVERSION_CLAIM];
      const state = delivered ? [...candidate.state.slice(0, 4), "sent"] : candidate.state;
      return storage.compareAndSet(keyFor(user.uid), expected, state, live.customClaims?.[CONVERSION_CLAIM]);
    },
  };
}

function createSqliteStorage(filename) {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS conversion_state (user_hash TEXT PRIMARY KEY, state_json TEXT NOT NULL)");
  const select = database.prepare("SELECT state_json FROM conversion_state WHERE user_hash = ?");
  const save = database.prepare("INSERT INTO conversion_state (user_hash, state_json) VALUES (?, ?) ON CONFLICT(user_hash) DO UPDATE SET state_json=excluded.state_json");
  return {
    read: key => {
      const row = select.get(key);
      return row ? JSON.parse(row.state_json) : undefined;
    },
    compareAndSet: (key, expected, state, legacy) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = select.get(key);
        const current = row ? JSON.parse(row.state_json) : legacy;
        if ((row && !validState(current)) || JSON.stringify(current) !== JSON.stringify(expected)) {
          database.exec("ROLLBACK");
          return false;
        }
        save.run(key, JSON.stringify(state));
        database.exec("COMMIT");
        return true;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => database.close(),
  };
}

async function paidUserIdsFromStripe(auth) {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) throw Error("payment_suppression_unavailable");
  const users = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...page.users.filter(user => user.email));
    pageToken = page.pageToken;
  } while (pageToken);
  const byEmail = new Map(users.map(user => [user.email.toLowerCase(), user.uid]));
  const byCustomer = new Map(users.filter(user => user.customClaims?.sc_customer_id).map(user => [user.customClaims.sc_customer_id, user.uid]));
  const userIds = new Set(users.map(user => user.uid));
  const paid = new Set();
  let cursor;
  do {
    const url = new URL("https://api.stripe.com/v1/charges");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("starting_after", cursor);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error("payment_suppression_read_failed");
    const body = await response.json();
    if (!Array.isArray(body.data)) throw Error("payment_suppression_invalid");
    for (const charge of body.data) {
      if (!charge.paid || charge.status !== "succeeded") continue;
      const uid = (userIds.has(charge.metadata?.user_id) && charge.metadata.user_id) ||
        byCustomer.get(charge.customer) || byEmail.get(String(charge.billing_details?.email || "").toLowerCase());
      if (uid) paid.add(uid);
    }
    cursor = body.has_more ? body.data.at(-1)?.id : null;
    if (body.has_more && !cursor) throw Error("payment_suppression_incomplete");
  } while (cursor);
  return paid;
}

module.exports = { CONVERSION_CLAIM, conversionCandidate, createConversionRunner, createConversionStateStore, createSqliteStorage, drainConversionMails, hasPaidHistory, validState, paidUserIdsFromStripe };
