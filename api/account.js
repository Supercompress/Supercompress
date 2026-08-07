const { json, readBody } = require("./_lib/http");
const { verifyUser, bearerToken } = require("./_lib/auth");
const { KEY_PREFIX } = require("./_lib/keys");
const { createKey, authenticateKey } = require("./_lib/firebase-key-store");
const { loadStore, mutateStore } = require("./_lib/store");
const { getPlan } = require("./_lib/stripe");
const admin = require("firebase-admin");
const {
  drainSecretOk,
  handleSignupWelcome,
  listPendingWelcomes,
  markWelcome,
  drainPendingWelcomes,
} = require("./_lib/welcome");
const {
  weeklyTick,
  listPendingWeekly,
  drainPendingWeekly,
  enqueueWeeklyCampaign,
  unsubscribeEmail,
  sendUnsubscribeLink,
  markWeekly,
  isoWeekCampaignId,
  tipCampaignId,
  shipCampaignId,
} = require("./_lib/weekly");

function normalizeCode(code) {
  return String(code || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeAgentUsage(raw = {}) {
  return Object.fromEntries(
    Object.entries(raw)
      .map(([agent, snap]) => [
        agent,
        {
          requests: snap.requests || 0,
          tokens_in: snap.tokens_in || 0,
          tokens_out: snap.tokens_out || 0,
          tokens_saved: snap.tokens_saved || 0,
          first_seen: snap.first_seen || null,
          last_seen: snap.last_seen || null,
        },
      ])
      .sort((a, b) => (b[1].tokens_saved || 0) - (a[1].tokens_saved || 0))
  );
}

function planUsage(owner, fallbackUsed = 0) {
  const {
    FREE_TOKENS_PER_MONTH,
    isPaygEnabled,
    billableTokens,
    estimatedOverageUsd,
    freeTokensRemaining,
  } = require("./_lib/stripe");
  const claims = owner?.customClaims || {};
  const plan = getPlan(claims.sc_plan || "free");
  const month = new Date().toISOString().slice(0, 7);
  const usage = claims.sc_usage?.month === month ? claims.sc_usage : {};
  const used = usage.tokens_in || fallbackUsed || 0;
  const payg = isPaygEnabled(plan.id);
  const unlimited = payg || plan.tokens_per_month < 0;
  const freeRemaining = freeTokensRemaining(used);
  const remaining = unlimited ? -1 : freeRemaining;
  return {
    plan: plan.id,
    plan_name: plan.name,
    tokens_per_month: FREE_TOKENS_PER_MONTH,
    free_tokens_per_month: FREE_TOKENS_PER_MONTH,
    tokens_used_this_period: used,
    tokens_remaining: remaining,
    free_tokens_remaining: freeRemaining,
    billable_tokens: billableTokens(used),
    estimated_overage_usd: estimatedOverageUsd(used),
    payg_enabled: payg,
    usage_pct: FREE_TOKENS_PER_MONTH > 0
      ? Math.min(100, Math.round((Math.min(used, FREE_TOKENS_PER_MONTH) / FREE_TOKENS_PER_MONTH) * 10000) / 100)
      : 0,
    unlimited,
    limit_reached: !payg && freeRemaining === 0,
    upgrade_url: "https://supercompress.dev/dashboard#billing",
  };
}

async function linkedStatus(code) {
  const store = await loadStore();
  const rec = store.connections?.[code];
  if (!rec) return null;
  return {
    code,
    status: rec.secret ? "linked" : "pending",
    owner_uid: rec.owner_uid || null,
    secret: rec.secret || null,
    linked_at: rec.linked_at || null,
    created_at: rec.created_at || null,
  };
}

async function handleConnectDevice(req, res) {
  const code = normalizeCode((req.method === "GET" ? req.query?.code : readBody(req)?.code) || "");
  if (!code || code.length < 6) return json(res, 422, { detail: "Valid code required" });

  if (req.method === "GET") {
    const status = await linkedStatus(code);
    if (!status) return json(res, 404, { detail: "Connection code not found" });
    return json(res, 200, status);
  }

  if (req.method !== "POST") return json(res, 405, { detail: "Method not allowed" });

  try {
    const user = await verifyUser(req);
    const owner = await admin.auth().getUser(user.uid).catch(() => ({ uid: user.uid, customClaims: {} }));
    const plan = getPlan(owner.customClaims?.sc_plan || "free");
    const key = await createKey(user.uid, "Default", plan.max_keys);
    const secret = key.secret || key.full_key || null;
    if (!secret || !String(secret).startsWith(KEY_PREFIX)) {
      return json(res, 500, { detail: "Could not create account key" });
    }

    await mutateStore((store) => {
      if (!store.connections) store.connections = {};
      store.connections[code] = {
        code,
        owner_uid: user.uid,
        secret,
        linked_at: new Date().toISOString(),
        created_at: store.connections[code]?.created_at || new Date().toISOString(),
      };
      return true;
    });

    return json(res, 200, {
      code,
      status: "linked",
      owner_uid: user.uid,
      secret,
      key_id: key.key?.id || null,
    });
  } catch (err) {
    return json(res, err.status || 401, { detail: err.message });
  }
}

async function handleUsage(req, res) {
  if (req.method !== "GET") return json(res, 405, { detail: "Method not allowed" });

  try {
    const raw = req.headers["x-api-key"] || bearerToken(req.headers.authorization) || (req.query && req.query.api_key);
    if (raw && raw.startsWith(KEY_PREFIX)) {
      const authenticated = await authenticateKey(raw);
      const { loadCodingAgentUsage } = require("./_lib/store");
      const usage = await loadCodingAgentUsage(authenticated.ownerUid);
      const total = Object.values(usage).reduce((acc, snap) => ({
        requests: acc.requests + (snap.requests || 0),
        tokens_in: acc.tokens_in + (snap.tokens_in || 0),
        tokens_out: acc.tokens_out + (snap.tokens_out || 0),
        tokens_saved: acc.tokens_saved + (snap.tokens_saved || 0),
      }), { requests: 0, tokens_in: 0, tokens_out: 0, tokens_saved: 0 });

      return json(res, 200, {
        owner_uid: authenticated.ownerUid,
        total_requests: total.requests,
        total_tokens_in: total.tokens_in,
        total_tokens_out: total.tokens_out,
        total_tokens_saved: total.tokens_saved,
        coding_agent_usage: normalizeAgentUsage(usage),
        ...planUsage(authenticated.owner, total.tokens_in),
      });
    }

    const user = await verifyUser(req);
    const { loadCodingAgentUsage } = require("./_lib/store");
    const usage = await loadCodingAgentUsage(user.uid);
    const total = Object.values(usage).reduce((acc, snap) => ({
      requests: acc.requests + (snap.requests || 0),
      tokens_in: acc.tokens_in + (snap.tokens_in || 0),
      tokens_out: acc.tokens_out + (snap.tokens_out || 0),
      tokens_saved: acc.tokens_saved + (snap.tokens_saved || 0),
    }), { requests: 0, tokens_in: 0, tokens_out: 0, tokens_saved: 0 });

    const owner = await admin.auth().getUser(user.uid);
    return json(res, 200, {
      owner_uid: user.uid,
      total_requests: total.requests,
      total_tokens_in: total.tokens_in,
      total_tokens_out: total.tokens_out,
      total_tokens_saved: total.tokens_saved,
      coding_agent_usage: normalizeAgentUsage(usage),
      ...planUsage(owner, total.tokens_in),
    });
  } catch (err) {
    return json(res, err.status || 401, { detail: err.message });
  }
}

async function handleAuthStatus(req, res) {
  if (req.method !== "GET") return json(res, 405, { detail: "Method not allowed" });

  const hasJson = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim());
  const hasParts = Boolean(
    process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
  );
  const storeReady = hasJson || hasParts;

  return json(res, 200, {
    sc_auth_dev: process.env.SC_AUTH_DEV === "1" || process.env.SC_AUTH_DEV === "true",
    storage: storeReady ? "firestore" : "in-memory-only",
    firebase_client: Boolean(
      process.env.FIREBASE_API_KEY && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_AUTH_DOMAIN
    ),
    firebase_admin: storeReady,
    firebase_project_id_set: Boolean(process.env.FIREBASE_PROJECT_ID),
    note: storeReady
      ? "Firestore backing the persistent store + CCR cache"
      : "Add FIREBASE_SERVICE_ACCOUNT_JSON (or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY) on Vercel, then redeploy",
  });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  const op = String(req.query?.op || "").trim();
  if (op === "connect-device") return handleConnectDevice(req, res);
  if (op === "usage") return handleUsage(req, res);
  if (op === "auth-status") return handleAuthStatus(req, res);

  // Signup welcome automation (no extra serverless function — Hobby 12-fn limit)
  if (op === "welcome" && req.method === "POST") {
    try {
      const user = await verifyUser(req);
      const body = readBody(req);
      return json(res, 200, await handleSignupWelcome(req, body, user));
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message || "Welcome email failed" });
    }
  }
  if (op === "welcome-pending" && req.method === "GET") {
    if (!drainSecretOk(req)) return json(res, 401, { detail: "Unauthorized" });
    try {
      const pending = await listPendingWelcomes();
      return json(res, 200, { pending, count: pending.length });
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message });
    }
  }
  if (op === "welcome-mark" && req.method === "POST") {
    const body = readBody(req);
    if (!drainSecretOk(req, body)) return json(res, 401, { detail: "Unauthorized" });
    const uid = String(body.uid || "").trim();
    if (!uid) return json(res, 422, { detail: "uid required" });
    const status = body.status === "failed" ? "failed" : "sent";
    try {
      const record = await markWelcome(uid, {
        status,
        sent_at: status === "sent" ? new Date().toISOString() : null,
        provider: body.provider || "gog",
        error: body.error || null,
      });
      return json(res, 200, { ok: true, record });
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message });
    }
  }
  if (op === "welcome-drain" && (req.method === "POST" || req.method === "GET")) {
    const body = req.method === "POST" ? readBody(req) : {};
    if (!drainSecretOk(req, body)) return json(res, 401, { detail: "Unauthorized" });
    try {
      const result = await drainPendingWelcomes();
      let weekly = null;
      try {
        weekly = await weeklyTick();
      } catch (weeklyErr) {
        weekly = { ok: false, error: weeklyErr.message || "weekly_tick_failed" };
      }
      return json(res, 200, { ok: true, ...result, weekly });
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message });
    }
  }

  if (op === "weekly-tick" && (req.method === "POST" || req.method === "GET")) {
    const body = req.method === "POST" ? readBody(req) : {};
    if (!drainSecretOk(req, body)) return json(res, 401, { detail: "Unauthorized" });
    try {
      const force = String(body.force || req.query?.force || "").trim();
      return json(res, 200, await weeklyTick(force ? { force } : {}));
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message || "Weekly tick failed" });
    }
  }
  if (op === "weekly-enqueue" && (req.method === "POST" || req.method === "GET")) {
    const body = req.method === "POST" ? readBody(req) : {};
    if (!drainSecretOk(req, body)) return json(res, 401, { detail: "Unauthorized" });
    try {
      const force = String(body.force || req.query?.force || "").trim();
      const defaultId =
        force === "ship" || String(force).endsWith("-ship")
          ? shipCampaignId()
          : force === "tip" || String(force).endsWith("-tip")
            ? tipCampaignId()
            : isoWeekCampaignId();
      const campaignId =
        String(body.campaign_id || req.query?.campaign_id || "").trim() ||
        (force && force.includes("-") ? force : defaultId);
      return json(res, 200, { ok: true, ...(await enqueueWeeklyCampaign(campaignId)) });
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message });
    }
  }
  if (op === "weekly-pending" && req.method === "GET") {
    if (!drainSecretOk(req)) return json(res, 401, { detail: "Unauthorized" });
    try {
      const pending = await listPendingWeekly(req.query?.campaign_id || null, {
        includeHtml: String(req.query?.html || "1") !== "0",
      });
      return json(res, 200, {
        pending,
        count: pending.length,
        campaign_id: req.query?.campaign_id || isoWeekCampaignId(),
      });
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message });
    }
  }
  if (op === "weekly-drain" && (req.method === "POST" || req.method === "GET")) {
    const body = req.method === "POST" ? readBody(req) : {};
    if (!drainSecretOk(req, body)) return json(res, 401, { detail: "Unauthorized" });
    try {
      const limit = Number(body.limit || req.query?.limit || 0) || undefined;
      return json(res, 200, {
        ok: true,
        ...(await drainPendingWeekly({ limit })),
      });
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message });
    }
  }
  if (op === "weekly-mark" && req.method === "POST") {
    const body = readBody(req);
    if (!drainSecretOk(req, body)) return json(res, 401, { detail: "Unauthorized" });
    const key = String(body.key || "").trim();
    if (!key) return json(res, 422, { detail: "key required" });
    const status = body.status === "failed" ? "failed" : "sent";
    try {
      const record = await markWeekly(key, {
        status,
        sent_at: status === "sent" ? new Date().toISOString() : null,
        provider: body.provider || "gog",
        error: body.error || null,
      });
      return json(res, 200, { ok: true, record });
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message });
    }
  }
  if (op === "weekly-mark-campaign" && req.method === "POST") {
    const body = readBody(req);
    if (!drainSecretOk(req, body)) return json(res, 401, { detail: "Unauthorized" });
    const campaignId = String(body.campaign_id || "").trim();
    if (!campaignId) return json(res, 422, { detail: "campaign_id required" });
    const status = body.status === "failed" ? "failed" : "sent";
    try {
      const result = await mutateStore((store) => {
        if (!store.weekly_emails) store.weekly_emails = {};
        let marked = 0;
        let skipped = 0;
        for (const [key, rec] of Object.entries(store.weekly_emails)) {
          if (!rec || rec.campaign_id !== campaignId) continue;
          if (rec.status === status) {
            skipped += 1;
            continue;
          }
          store.weekly_emails[key] = {
            ...rec,
            status,
            sent_at: status === "sent" ? new Date().toISOString() : rec.sent_at || null,
            provider: body.provider || "gog",
            error: body.error || null,
          };
          marked += 1;
        }
        return { marked, skipped };
      });
      return json(res, 200, { ok: true, campaign_id: campaignId, ...result });
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message });
    }
  }
  if (op === "weekly-unsubscribe" && (req.method === "GET" || req.method === "POST")) {
    const body = req.method === "POST" ? readBody(req) || {} : {};
    let email = String(body.email || req.query?.email || "").trim();
    let token = String(body.token || req.query?.token || "").trim();
    try {
      email = decodeURIComponent(email);
    } catch {
      /* keep raw */
    }
    try {
      token = decodeURIComponent(token);
    } catch {
      /* keep raw */
    }
    const confirmOnly =
      body.confirm === true ||
      body.confirm === "1" ||
      String(req.query?.confirm || "") === "1";
    try {
      return json(res, 200, await unsubscribeEmail(email, token, { confirmOnly }));
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message || "Unsubscribe failed" });
    }
  }
  if (op === "weekly-unsub-link" && req.method === "POST") {
    const body = readBody(req) || {};
    const email = String(body.email || "").trim();
    try {
      return json(res, 200, await sendUnsubscribeLink(email));
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message || "Could not send link" });
    }
  }

  return json(res, 404, { detail: "Unknown account operation" });
};
