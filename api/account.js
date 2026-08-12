const { json, readBody, checkRateLimit, softProbe, hasAuthCredentials } = require("./_lib/http");
const { verifyUser, bearerToken } = require("./_lib/auth");
const { KEY_PREFIX } = require("./_lib/keys");
const { createKey, revokeKey, listKeys, authenticateKey } = require("./_lib/firebase-key-store");
const { loadStore, mutateStore } = require("./_lib/store");
const { getPlan } = require("./_lib/stripe");
const admin = require("firebase-admin");

const CONNECT_GET_IP_RPM = 30;
const CONNECT_GET_CODE_RPM = 20;
const CONNECT_LINK_TTL_MS = 10 * 60 * 1000;
const {
  drainSecretOk,
  hasDrainCredentials,
  handleSignupWelcome,
  listPendingWelcomes,
  markWelcome,
  drainPendingWelcomes,
} = require("./_lib/welcome");
const { drainPendingPowerUsers } = require("./_lib/power-user");
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
      .map(([agent, snap]) => {
        const tokens_in = snap.tokens_in || 0;
        const tokens_saved = snap.tokens_saved || 0;
        const avg_cut_pct =
          tokens_in > 0
            ? Math.round((tokens_saved / tokens_in) * 10000) / 100
            : 0;
        return [
          agent,
          {
            requests: snap.requests || 0,
            tokens_in,
            tokens_out: snap.tokens_out || 0,
            tokens_saved,
            avg_cut_pct,
            avg_latency_ms: snap.avg_latency_ms || null,
            last_latency_ms: snap.last_latency_ms || null,
            last_pct: snap.last_pct != null ? snap.last_pct : null,
            last_query: snap.last_query || null,
            last_source: snap.last_source || null,
            first_seen: snap.first_seen || null,
            last_seen: snap.last_seen || null,
          },
        ];
      })
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
    isComped,
    isLegacyMetered,
    isCreditWallet,
    normalizeCreditLimitUsd,
    DEFAULT_CREDIT_LIMIT_USD,
    roundUsd,
  } = require("./_lib/stripe");
  const claims = owner?.customClaims || {};
  const plan = getPlan(claims.sc_plan || "free");
  const month = new Date().toISOString().slice(0, 7);
  const usage = claims.sc_usage?.month === month ? claims.sc_usage : {};
  // Prefer the higher of mirrored claims vs caller-supplied ledger/agent totals so
  // CLI/dashboard never under-report when one source lags.
  const used = Math.max(Number(usage.tokens_in || 0), Number(fallbackUsed || 0));
  const payg = isPaygEnabled(plan.id);
  const unlimited = isComped(claims) || isLegacyMetered(claims);
  const freeRemaining = freeTokensRemaining(used);
  const remaining = unlimited ? -1 : freeRemaining;
  const creditWallet = isCreditWallet(claims);
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
    credit_wallet: creditWallet,
    credit_balance_usd: roundUsd(claims.sc_credit_balance_usd || 0),
    credit_limit_usd: normalizeCreditLimitUsd(claims.sc_credit_limit_usd, DEFAULT_CREDIT_LIMIT_USD),
    auto_recharge: Boolean(claims.sc_auto_recharge),
    usage_pct: FREE_TOKENS_PER_MONTH > 0
      ? Math.min(100, Math.round((Math.min(used, FREE_TOKENS_PER_MONTH) / FREE_TOKENS_PER_MONTH) * 10000) / 100)
      : 0,
    unlimited,
    limit_reached: !payg && !creditWallet && freeRemaining === 0,
    upgrade_url: "https://www.supercompress.dev/dashboard#billing",
    upgrade_hint:
      "Free 1M tokens used this month. Compression is paused — add a payment method ($0.30/1M after free) to unlock.",
    paywall: !payg && !creditWallet && freeRemaining === 0
      ? {
          title: "Free allowance used — unlock to keep compressing",
          detail: "You've hit your free 1M tokens this month. Add a payment method to resume.",
          cta: "Add payment method",
          price: "$0.30 / 1M tokens after free",
        }
      : null,
  };
}

async function linkedStatus(code) {
  // Auth-only device link (no gist).
  const { getDeviceLink } = require("./_lib/auth-connect");
  return getDeviceLink(code);
}

const PLUGIN_KEY_NAME = "Coding agent";
const ROTATABLE_KEY_NAME =
  /^(coding agent|cli|mcp|default|plugin|device|setup)(\s|$)/i;

/**
 * Mint a coding-agent key via Firebase Auth (no gist/Firestore).
 * Rotates prior Auth plugin keys when at plan limit.
 */
async function mintConnectKey(ownerUid, maxKeys) {
  const {
    createAuthPluginKey,
    listAuthPluginKeys,
    revokeAuthPluginKey,
  } = require("./_lib/auth-connect");

  const existing = await listAuthPluginKeys(ownerUid).catch(() => []);
  if (existing.length >= maxKeys) {
    const pool = existing
      .filter((k) => ROTATABLE_KEY_NAME.test(String(k.name || "")))
      .slice()
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    // Never fall back to rotating arbitrary production keys — fail setup instead.
    if (!pool.length) {
      const err = new Error(
        `API key limit reached (${maxKeys}). Revoke an unused coding-agent/CLI key in the dashboard, then retry connect.`
      );
      err.status = 409;
      err.code = "key_limit_reached";
      throw err;
    }
    const victims = pool.slice(0, Math.max(1, existing.length - maxKeys + 1));
    for (const victim of victims.slice(0, 3)) {
      try {
        await revokeAuthPluginKey(ownerUid, victim.id);
      } catch (_) {
        /* continue */
      }
    }
  }
  return createAuthPluginKey(ownerUid, PLUGIN_KEY_NAME);
}

async function handleConnectDevice(req, res) {
  const { getDeviceLink, putDeviceLink } = require("./_lib/auth-connect");
  const code = normalizeCode((req.method === "GET" ? req.query?.code : readBody(req)?.code) || "");
  if (!code || code.length < 6) {
    // Bots hit /api/connect-device with no code — soft 200 avoids error-rate spikes.
    return json(res, 200, {
      ok: false,
      status: "invalid_code",
      detail: "Valid connect code required (?code=…)",
    });
  }

  if (req.method === "GET") {
    try {
      // Unauthenticated poll by design (CLI/MCP) — rate-limit brute enumeration.
      const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
        .split(",")[0]
        .trim()
        .slice(0, 80);
      const rlIp = checkRateLimit(`connect:ip:${ip}`, CONNECT_GET_IP_RPM);
      const rlCode = checkRateLimit(`connect:code:${code}`, CONNECT_GET_CODE_RPM);
      if (!rlIp.allowed || !rlCode.allowed) {
        const resetMs = Math.max(rlIp.resetMs || 0, rlCode.resetMs || 0);
        return json(res, 429, {
          detail: "Too many connect-device polls. Slow down and retry.",
          retry_after_seconds: Math.max(1, Math.ceil((resetMs - Date.now()) / 1000)),
        });
      }

      const { clearDeviceLinkSecret } = require("./_lib/auth-connect");
      const status = await getDeviceLink(code);
      if (!status) {
        // MCP/CLI polls every ~1.5s before the user finishes browser login.
        return json(res, 200, {
          code,
          status: "waiting",
          owner_uid: null,
          secret: null,
          linked_at: null,
          created_at: null,
        });
      }

      const linkedAt = status.linked_at || status.created_at;
      const ageMs = linkedAt ? Date.now() - new Date(linkedAt).getTime() : 0;
      if (status.secret && ageMs > CONNECT_LINK_TTL_MS) {
        try { await clearDeviceLinkSecret(code); } catch (_) { /* best-effort */ }
        return json(res, 410, {
          code,
          status: "expired",
          owner_uid: null,
          secret: null,
          detail: "Connection code expired. Run connect again.",
        });
      }

      if (!status.secret) {
        return json(res, 200, {
          code,
          status: status.status === "consumed" ? "consumed" : "waiting",
          owner_uid: status.owner_uid || null,
          secret: null,
          linked_at: status.linked_at || null,
          created_at: status.created_at || null,
        });
      }

      // Single-use: atomically consume secret (Firestore CAS when available).
      const { consumeDeviceLinkSecret } = require("./_lib/auth-connect");
      const taken = await consumeDeviceLinkSecret(code);
      if (!taken?.secret) {
        return json(res, 200, {
          code,
          status: "consumed",
          owner_uid: status.owner_uid || null,
          secret: null,
          linked_at: status.linked_at || null,
          created_at: status.created_at || null,
        });
      }
      return json(res, 200, {
        code,
        status: "linked",
        owner_uid: taken.owner_uid || null,
        secret: taken.secret,
        linked_at: taken.linked_at || status.linked_at || null,
        created_at: taken.created_at || status.created_at || null,
      });
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message || "Lookup failed" });
    }
  }

  if (req.method !== "POST") return softProbe(res, "Method not allowed");

  try {
    const user = await verifyUser(req);
    const owner = await admin.auth().getUser(user.uid).catch(() => ({ uid: user.uid, customClaims: {} }));
    const plan = getPlan(owner.customClaims?.sc_plan || "free");
    const key = await mintConnectKey(user.uid, plan.max_keys);
    const secret = key.secret || key.full_key || null;
    if (!secret || !String(secret).startsWith(KEY_PREFIX)) {
      return json(res, 500, { detail: "Could not create account key" });
    }

    const body = readBody(req) || {};
    const source = String(body.source || "oauth").trim().slice(0, 40) || "oauth";
    const agents = Array.isArray(body.agents)
      ? body.agents.map((a) => String(a || "").trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 20)
      : [];

    // Auth-only handshake — never touches gist/Firestore store.
    await putDeviceLink(code, {
      ownerUid: user.uid,
      secret,
      source,
      agents,
    });

    return json(res, 200, {
      code,
      status: "linked",
      owner_uid: user.uid,
      secret,
      key_id: key.key?.id || null,
      agent_plugin: {
        linked: true,
        source,
        agents,
      },
    });
  } catch (err) {
    return json(res, err.status || 401, { detail: err.message });
  }
}

async function handleUsage(req, res) {
  if (req.method !== "GET") return softProbe(res, "Method not allowed");

  try {
    const raw = req.headers["x-api-key"] || bearerToken(req.headers.authorization) || (req.query && req.query.api_key);
    let ownerUid;
    let owner;
    if (raw && raw.startsWith(KEY_PREFIX)) {
      const authenticated = await authenticateKey(raw);
      ownerUid = authenticated.ownerUid;
      owner = authenticated.owner;
    } else {
      const user = await verifyUser(req);
      ownerUid = user.uid;
      owner = await admin.auth().getUser(user.uid);
    }

    const { loadCodingAgentUsage, loadAgentPluginLink } = require("./_lib/store");
    const { loadLedger } = require("./_lib/billing-ledger");
    const usage = await loadCodingAgentUsage(ownerUid);
    const agent_plugin = await loadAgentPluginLink(ownerUid).catch(() => ({ linked: false }));
    const agentTotal = Object.values(usage).reduce(
      (acc, snap) => ({
        requests: acc.requests + (snap.requests || 0),
        tokens_in: acc.tokens_in + (snap.tokens_in || 0),
        tokens_out: acc.tokens_out + (snap.tokens_out || 0),
        tokens_saved: acc.tokens_saved + (snap.tokens_saved || 0),
      }),
      { requests: 0, tokens_in: 0, tokens_out: 0, tokens_saved: 0 }
    );

    // Billing ledger is the same meter the dashboard KPIs prefer.
    let ledger = null;
    try {
      ledger = await loadLedger(ownerUid, owner.customClaims || {});
    } catch (_) {
      ledger = null;
    }
    const month = new Date().toISOString().slice(0, 7);
    const ledgerMatchesMonth = ledger && String(ledger.month || "") === month;
    const total_requests = Math.max(
      Number(ledgerMatchesMonth ? ledger.requests : 0) || 0,
      agentTotal.requests
    );
    const total_tokens_in = Math.max(
      Number(ledgerMatchesMonth ? ledger.tokens_in : 0) || 0,
      agentTotal.tokens_in
    );
    const total_tokens_out = Math.max(
      Number(ledgerMatchesMonth ? ledger.tokens_out : 0) || 0,
      agentTotal.tokens_out
    );
    const total_tokens_saved = Math.max(
      Number(ledgerMatchesMonth ? ledger.tokens_saved : 0) || 0,
      agentTotal.tokens_saved
    );

    // Always expose the same maxed meter as totals — clients (CLI, analytics)
    // must not see account_usage:null while total_* is non-zero.
    const account_usage = {
      month,
      requests: total_requests,
      tokens_in: total_tokens_in,
      tokens_out: total_tokens_out,
      tokens_saved: total_tokens_saved,
    };
    return json(res, 200, {
      owner_uid: ownerUid,
      total_requests,
      total_tokens_in,
      total_tokens_out,
      total_tokens_saved,
      coding_agent_usage: normalizeAgentUsage(usage),
      coding_agent_totals: agentTotal,
      account_usage,
      ledger_usage: ledgerMatchesMonth
        ? {
            month,
            requests: Number(ledger.requests || 0),
            tokens_in: Number(ledger.tokens_in || 0),
            tokens_out: Number(ledger.tokens_out || 0),
            tokens_saved: Number(ledger.tokens_saved || 0),
          }
        : null,
      meter: ledgerMatchesMonth ? "billing_ledger" : "coding_agent",
      agent_plugin,
      ...planUsage(owner, total_tokens_in),
    });
  } catch (err) {
    // Unauthenticated scanner GETs — soft 200 so Observability error rate stays honest.
    if ((err.status || 401) === 401) {
      return json(res, 200, { ok: false, auth: "required", detail: err.message || "Authorization required" });
    }
    return json(res, err.status || 500, { detail: err.message });
  }
}

async function resolveOwnerFromReq(req) {
  const raw = req.headers["x-api-key"] || bearerToken(req.headers.authorization) || (req.query && req.query.api_key);
  if (raw && String(raw).startsWith(KEY_PREFIX)) {
    const authenticated = await authenticateKey(raw);
    return {
      uid: authenticated.ownerUid,
      owner: authenticated.owner,
      via: "api_key",
      key_prefix: authenticated.user?.prefix || String(raw).slice(0, 16),
    };
  }
  const user = await verifyUser(req);
  const owner = await admin.auth().getUser(user.uid);
  return { uid: user.uid, owner, via: "firebase", key_prefix: null };
}

async function handleMe(req, res) {
  if (req.method !== "GET") return softProbe(res, "Method not allowed");
  try {
    const { uid, owner, via, key_prefix } = await resolveOwnerFromReq(req);
    const { loadAgentPluginLink, loadCodingAgentUsage } = require("./_lib/store");
    const agent_plugin = await loadAgentPluginLink(uid).catch(() => ({ linked: false }));
    const usage = await loadCodingAgentUsage(uid).catch(() => ({}));
    const totalIn = Object.values(usage).reduce((n, s) => n + (s.tokens_in || 0), 0);

    let plugin_keys = [];
    try {
      const { listAuthPluginKeys } = require("./_lib/auth-connect");
      plugin_keys = (await listAuthPluginKeys(uid)).map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        created_at: k.created_at || null,
        last_used_at: k.last_used_at || null,
      }));
    } catch (_) {
      plugin_keys = [];
    }

    let api_keys = [];
    try {
      const listed = await listKeys(uid);
      const rows = Array.isArray(listed) ? listed : listed?.keys || [];
      api_keys = rows.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        created_at: k.created_at || null,
        last_used_at: k.last_used_at || null,
      }));
    } catch (_) {
      api_keys = [];
    }

    return json(res, 200, {
      uid,
      email: owner.email || null,
      display_name: owner.displayName || null,
      email_verified: Boolean(owner.emailVerified),
      created_at: owner.metadata?.creationTime || null,
      last_sign_in: owner.metadata?.lastSignInTime || null,
      auth_via: via,
      key_prefix: key_prefix || null,
      agent_plugin,
      plugin_keys,
      api_keys,
      dashboard_url: "https://www.supercompress.dev/dashboard",
      ...planUsage(owner, totalIn),
    });
  } catch (err) {
    if ((err.status || 401) === 401) {
      return json(res, 200, { ok: false, auth: "required", detail: err.message || "Authorization required" });
    }
    return json(res, err.status || 500, { detail: err.message });
  }
}

async function handleCompressLog(req, res) {
  if (req.method !== "GET") return softProbe(res, "Method not allowed");
  try {
    const { uid } = await resolveOwnerFromReq(req);
    const limit = Number(req.query?.limit) || 40;
    const { listCompressLog } = require("./_lib/compress-log");
    const data = await listCompressLog(uid, { limit });
    return json(res, 200, { owner_uid: uid, ...data });
  } catch (err) {
    if ((err.status || 401) === 401) {
      return json(res, 200, { ok: false, auth: "required", detail: err.message || "Authorization required" });
    }
    return json(res, err.status || 500, { detail: err.message });
  }
}

async function handleAuthStatus(req, res) {
  if (req.method !== "GET") return softProbe(res, "Method not allowed");

  const hasJson = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim());
  const hasParts = Boolean(
    process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
  );
  const storeReady = hasJson || hasParts;
  const { gistConfigured } = require("./_lib/gist-store");
  // Report intended primary backend (Firestore when Admin is configured).
  const storage = storeReady ? "firestore" : gistConfigured() ? "github-gist" : "in-memory-only";

  return json(res, 200, {
    sc_auth_dev: process.env.SC_AUTH_DEV === "1" || process.env.SC_AUTH_DEV === "true",
    storage,
    firebase_client: Boolean(
      process.env.FIREBASE_API_KEY && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_AUTH_DOMAIN
    ),
    firebase_admin: storeReady,
    firebase_project_id_set: Boolean(process.env.FIREBASE_PROJECT_ID),
    gist_fallback: gistConfigured(),
    note: storeReady
      ? "Firestore is primary store; GitHub gist is emergency fallback only"
      : gistConfigured()
        ? "Using GitHub gist store (Firebase Admin not configured)"
        : "Add FIREBASE_SERVICE_ACCOUNT_JSON (or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY) on Vercel, then redeploy",
  });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  const op = String(req.query?.op || "").trim();
  if (op === "connect-device") return handleConnectDevice(req, res);
  if (op === "usage") return handleUsage(req, res);
  if (op === "me" || op === "account") return handleMe(req, res);
  if (op === "compress-log" || op === "activity") return handleCompressLog(req, res);
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
    if (!drainSecretOk(req)) {
      if (!hasDrainCredentials(req)) return softProbe(res, "Unauthorized", { auth: "required" });
      return json(res, 401, { detail: "Unauthorized" });
    }
    try {
      const pending = await listPendingWelcomes();
      return json(res, 200, { pending, count: pending.length });
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message });
    }
  }
  if (op === "welcome-mark" && req.method === "POST") {
    const body = readBody(req);
    if (!drainSecretOk(req, body)) {
      if (!hasDrainCredentials(req, body)) return softProbe(res, "Unauthorized", { auth: "required" });
      return json(res, 401, { detail: "Unauthorized" });
    }
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
    if (!drainSecretOk(req, body)) {
      if (!hasDrainCredentials(req, body)) return softProbe(res, "Unauthorized", { auth: "required" });
      return json(res, 401, { detail: "Unauthorized" });
    }
    try {
      const result = await drainPendingWelcomes();
      let power_user = null;
      try {
        power_user = await drainPendingPowerUsers();
      } catch (powerErr) {
        power_user = { ok: false, error: powerErr.message || "power_user_drain_failed" };
      }
      // Also nudge weekly queue so mid-week backlog clears on the daily cron.
      let weekly = null;
      try {
        weekly = await weeklyTick();
      } catch (weeklyErr) {
        weekly = { ok: false, error: weeklyErr.message || "weekly_tick_failed" };
      }
      return json(res, 200, { ok: true, ...result, power_user, weekly });
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message });
    }
  }

  // Weekly product emails to all users
  if (op === "weekly-tick" && (req.method === "POST" || req.method === "GET")) {
    const body = req.method === "POST" ? readBody(req) : {};
    if (!drainSecretOk(req, body)) {
      if (!hasDrainCredentials(req, body)) return softProbe(res, "Unauthorized", { auth: "required" });
      return json(res, 401, { detail: "Unauthorized" });
    }
    try {
      const force = String(body.force || req.query?.force || "").trim();
      return json(res, 200, await weeklyTick(force ? { force } : {}));
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message || "Weekly tick failed" });
    }
  }
  if (op === "weekly-enqueue" && (req.method === "POST" || req.method === "GET")) {
    const body = req.method === "POST" ? readBody(req) : {};
    if (!drainSecretOk(req, body)) {
      if (!hasDrainCredentials(req, body)) return softProbe(res, "Unauthorized", { auth: "required" });
      return json(res, 401, { detail: "Unauthorized" });
    }
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
    if (!drainSecretOk(req)) {
      if (!hasDrainCredentials(req)) return softProbe(res, "Unauthorized", { auth: "required" });
      return json(res, 401, { detail: "Unauthorized" });
    }
    try {
      // Always include branded HTML — Resend + preview tooling need it (plain text alone looks unstyled).
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
    if (!drainSecretOk(req, body)) {
      if (!hasDrainCredentials(req, body)) return softProbe(res, "Unauthorized", { auth: "required" });
      return json(res, 401, { detail: "Unauthorized" });
    }
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
    if (!drainSecretOk(req, body)) {
      if (!hasDrainCredentials(req, body)) return softProbe(res, "Unauthorized", { auth: "required" });
      return json(res, 401, { detail: "Unauthorized" });
    }
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
    if (!drainSecretOk(req, body)) {
      if (!hasDrainCredentials(req, body)) return softProbe(res, "Unauthorized", { auth: "required" });
      return json(res, 401, { detail: "Unauthorized" });
    }
    const campaignId = String(body.campaign_id || "").trim();
    if (!campaignId) return json(res, 422, { detail: "campaign_id required" });
    const status = body.status === "failed" ? "failed" : "sent";
    try {
      const { mutateStore } = require("./_lib/store");
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
    try {
      // Authenticated account may unsubscribe their own verified email without the mail token.
      let authedSelf = false;
      try {
        const user = await verifyUser(req);
        if (user?.email && String(user.email).trim().toLowerCase() === email.toLowerCase()) {
          authedSelf = true;
        }
      } catch (_) {
        /* anonymous one-click from email */
      }
      if (authedSelf && !token) {
        const { unsubToken } = require("./_lib/weekly");
        token = unsubToken(email);
      }
      return json(res, 200, await unsubscribeEmail(email, token));
    } catch (err) {
      // Scanner / empty query → soft 200 (Observability). Real broken tokens stay 401.
      const msg = String(err.message || "");
      if (!email || /invalid email/i.test(msg)) {
        return softProbe(res, err.message || "Invalid email");
      }
      if (!token && !hasAuthCredentials(req)) {
        return softProbe(res, "Unsubscribe token required", { auth: "required" });
      }
      // Broken / missing token → tell the client to request a fresh signed link (do not unsub).
      if (err.status === 401 || err.code === "invalid_token") {
        return json(res, 401, {
          detail: err.message || "Invalid unsubscribe token",
          code: "invalid_token",
          hint: "Request a fresh signed link via weekly-unsub-link",
        });
      }
      return json(res, err.status || 500, { detail: err.message || "Unsubscribe failed" });
    }
  }
  if (op === "weekly-unsub-link" && req.method === "POST") {
    const body = readBody(req) || {};
    const email = String(body.email || "").trim();
    const { checkRateLimit, clientIp, jsonWithRateLimit } = require("./_lib/http");
    const { checkDurableRateLimit } = require("./_lib/rate-limit-durable");
    const ip = clientIp(req);
    const mem = checkRateLimit(`unsub-link:${ip}`, 5);
    if (!mem.allowed) {
      return jsonWithRateLimit(res, 429, { detail: "Too many requests. Try again later." }, mem);
    }
    const recipKey = `unsub-link-to:${String(email).trim().toLowerCase()}`;
    const recipMem = checkRateLimit(recipKey, 2, 60 * 60_000);
    if (!recipMem.allowed) {
      return json(res, 429, { detail: "A link was already sent recently. Check your inbox." });
    }
    try {
      const durable = await checkDurableRateLimit(`unsub-link:${ip}`, 10, 60 * 60_000);
      if (durable.backend === "firestore" && !durable.allowed) {
        return jsonWithRateLimit(res, 429, { detail: "Too many requests. Try again later." }, durable);
      }
    } catch (_) {}
    try {
      return json(res, 200, await sendUnsubscribeLink(email));
    } catch (err) {
      return json(res, err.status || 500, { detail: err.message || "Could not send link" });
    }
  }

  return json(res, 200, {
    ok: true,
    detail: "Specify ?op=…",
    ops: [
      "auth-status",
      "usage",
      "connect-device",
      "welcome",
      "welcome-drain",
      "weekly-tick",
      "weekly-drain",
      "weekly-unsubscribe",
      "weekly-unsub-link",
    ],
  });
};
