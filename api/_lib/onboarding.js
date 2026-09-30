/**
 * Signup onboarding + free-token quests (10,000 each).
 * Durable on Auth claims — no Firestore required.
 */

const ONBOARD_ACTION_TOKENS = 10_000;
const ONBOARD_ACTIONS = ["star", "x_follow", "plugin"];
const HEARD_SOURCES = ["x", "reddit", "linkedin", "instagram", "word_of_mouth"];
const ONBOARD_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // new accounts (2 weeks — covers late deploys)

const REPO_URL = "https://github.com/Supercompress/Supercompress";
const X_FOLLOW_URL = "https://x.com/arjunkshah21";
const SITE_URL = "https://www.supercompress.dev";

function onboardBonusTokens(claims = {}) {
  const n = Number(claims.sc_onboard_bonus) || 0;
  return Math.max(0, Math.min(ONBOARD_ACTION_TOKENS * ONBOARD_ACTIONS.length, Math.floor(n)));
}

function normalizeHeard(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (s === "twitter") return "x";
  if (s === "wordofmouth" || s === "friend") return "word_of_mouth";
  return HEARD_SOURCES.includes(s) ? s : null;
}

function normalizeAction(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (s === "github" || s === "star_repo") return "star";
  if (s === "twitter" || s === "follow" || s === "x") return "x_follow";
  if (s === "install" || s === "mcp" || s === "coding_agent") return "plugin";
  return ONBOARD_ACTIONS.includes(s) ? s : null;
}

function parseActions(claims = {}) {
  const raw = claims.sc_onboard_actions;
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const key of ONBOARD_ACTIONS) {
    if (raw[key]) out[key] = true;
  }
  return out;
}

function accountCreatedMs(owner) {
  const raw = owner?.metadata?.creationTime || owner?.metadata?.creation_time || "";
  if (!raw) return null;
  const created = Date.parse(raw);
  return Number.isFinite(created) && created > 0 ? created : null;
}

function isYoungAccount(owner) {
  const created = accountCreatedMs(owner);
  if (created == null) return false;
  return Date.now() - created < ONBOARD_MAX_AGE_MS;
}

function needsOnboarding(claims = {}, owner = null) {
  if (claims.sc_onboard_done || claims.sc_onboard_skipped) return false;
  // Post-mutation payloads often omit owner — still treat unfinished users as in-flow.
  if (!owner) return true;
  const created = accountCreatedMs(owner);
  // Missing creationTime should not silently suppress onboarding for unfinished accounts.
  if (created == null) return true;
  return Date.now() - created < ONBOARD_MAX_AGE_MS;
}

function needsPowerCelebrate(claims = {}) {
  return String(claims.sc_power_celebrate || "") === "pending";
}

function powerShareIntentUrl({ tokensIn, tokensSaved, cutPct } = {}) {
  const tin = Number(tokensIn) || 0;
  const saved = Number(tokensSaved) || 0;
  const cut = Number(cutPct) || 0;
  const fmt = (n) => {
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
    return String(Math.round(n));
  };
  let brag = `Just hit power user on @arjunkshah21's SuperCompress — 1M+ tokens compressed.`;
  if (tin > 0 && saved > 0) {
    brag = `Just hit power user on SuperCompress — ${fmt(tin)} tokens in, ${fmt(saved)} saved${cut > 0 ? ` (~${cut}% cut)` : ""}.`;
  } else if (tin > 0) {
    brag = `Just hit power user on SuperCompress — crossed ${fmt(tin)} tokens compressed.`;
  }
  brag += `\n\nCut agent context, keep the answer → ${SITE_URL}`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(brag)}`;
}

function statusPayload(claims = {}, owner = null) {
  const actions = parseActions(claims);
  const completed = ONBOARD_ACTIONS.filter((a) => actions[a]);
  const bonus = onboardBonusTokens(claims);
  return {
    needs_onboarding: needsOnboarding(claims, owner),
    needs_power_celebrate: needsPowerCelebrate(claims),
    heard: claims.sc_heard || null,
    actions,
    completed_actions: completed,
    bonus_tokens: bonus,
    action_tokens: ONBOARD_ACTION_TOKENS,
    max_bonus_tokens: ONBOARD_ACTION_TOKENS * ONBOARD_ACTIONS.length,
    links: {
      star: REPO_URL,
      x_follow: X_FOLLOW_URL,
      site: SITE_URL,
      plugin_docs: `${SITE_URL}/docs/coding-agents`,
    },
    plugin_commands: [
      "npx supercompress-proxy setup",
      "npm i -g supercompress-proxy && supercompress setup",
    ],
    power_share_url: powerShareIntentUrl({
      tokensIn: claims.sc_usage?.tokens_in,
      tokensSaved: claims.sc_usage?.tokens_saved,
      cutPct:
        claims.sc_usage?.tokens_in > 0
          ? Math.round((Number(claims.sc_usage.tokens_saved || 0) / claims.sc_usage.tokens_in) * 100)
          : 0,
    }),
  };
}

async function persistOnboardingRecord(uid, patch) {
  if (!uid) return;
  try {
    const { mutateStore } = require("./store");
    await mutateStore((store) => {
      if (!store.onboarding) store.onboarding = {};
      const prev = store.onboarding[uid] && typeof store.onboarding[uid] === "object" ? store.onboarding[uid] : {};
      store.onboarding[uid] = {
        ...prev,
        uid,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      return store.onboarding[uid];
    });
  } catch (err) {
    console.warn("onboarding store persist skipped:", err.message || err);
  }
}

async function loadOnboardingRecord(uid) {
  if (!uid) return null;
  try {
    const { loadStore } = require("./store");
    const store = await loadStore({ forceRemote: false });
    const rec = store?.onboarding?.[uid];
    return rec && typeof rec === "object" ? rec : null;
  } catch {
    return null;
  }
}

async function mergeOnboardingClaims(uid, mutator) {
  const { patchUserClaims } = require("./billing-ledger");
  return patchUserClaims(uid, (live) => mutator({ ...live }));
}

async function saveHeard(uid, source) {
  const heard = normalizeHeard(source);
  if (!heard) {
    const err = new Error("Invalid source");
    err.status = 400;
    throw err;
  }
  const at = new Date().toISOString();
  await persistOnboardingRecord(uid, { heard, heard_at: at });
  let claims = {};
  try {
    claims = await mergeOnboardingClaims(uid, (c) => {
      c.sc_heard = heard;
      // Keep claims tiny — timestamp lives in the durable store.
      delete c.sc_heard_at;
      return c;
    });
  } catch (err) {
    console.warn("saveHeard claims stamp failed:", err.message || err);
    const rec = await loadOnboardingRecord(uid);
    return statusPayload({ sc_heard: rec?.heard || heard });
  }
  return statusPayload(claims);
}

async function claimAction(uid, actionRaw) {
  const action = normalizeAction(actionRaw);
  if (!action) {
    const err = new Error("Invalid action");
    err.status = 400;
    throw err;
  }
  const at = new Date().toISOString();
  await persistOnboardingRecord(uid, {
    [`action_${action}`]: true,
    [`action_${action}_at`]: at,
  });
  let claims = {};
  try {
    claims = await mergeOnboardingClaims(uid, (c) => {
      const actions = parseActions(c);
      if (!actions[action]) {
        actions[action] = true;
        c.sc_onboard_actions = actions;
        const count = ONBOARD_ACTIONS.filter((a) => actions[a]).length;
        c.sc_onboard_bonus = count * ONBOARD_ACTION_TOKENS;
      }
      if (ONBOARD_ACTIONS.every((a) => actions[a])) {
        c.sc_onboard_done = true;
      }
      return c;
    });
  } catch (err) {
    console.warn("claimAction claims stamp failed:", err.message || err);
    const rec = await loadOnboardingRecord(uid);
    const actions = {};
    for (const key of ONBOARD_ACTIONS) {
      if (rec?.[`action_${key}`]) actions[key] = true;
    }
    claims = { sc_onboard_actions: actions, sc_heard: rec?.heard || null };
  }
  return statusPayload(claims);
}

async function skipOnboarding(uid) {
  await persistOnboardingRecord(uid, { skipped: true, skipped_at: new Date().toISOString() });
  let claims = {};
  try {
    claims = await mergeOnboardingClaims(uid, (c) => {
      c.sc_onboard_skipped = true;
      return c;
    });
  } catch (err) {
    console.warn("skipOnboarding claims stamp failed:", err.message || err);
    const rec = await loadOnboardingRecord(uid);
    claims = { sc_onboard_skipped: true, sc_heard: rec?.heard || null };
  }
  return statusPayload(claims);
}

async function markOnboardingDone(uid) {
  await persistOnboardingRecord(uid, { done: true, done_at: new Date().toISOString() });
  let claims = {};
  try {
    claims = await mergeOnboardingClaims(uid, (c) => {
      c.sc_onboard_done = true;
      return c;
    });
  } catch (err) {
    console.warn("markOnboardingDone claims stamp failed:", err.message || err);
    const rec = await loadOnboardingRecord(uid);
    claims = { sc_onboard_done: true, sc_heard: rec?.heard || null };
  }
  return statusPayload(claims);
}

async function markPowerCelebrateShown(uid) {
  const claims = await mergeOnboardingClaims(uid, (c) => {
    c.sc_power_celebrate = "shown";
    c.sc_power_celebrate_at = new Date().toISOString();
    return c;
  });
  return statusPayload(claims);
}

async function markPowerCelebratePending(uid) {
  try {
    await mergeOnboardingClaims(uid, (c) => {
      if (c.sc_power_celebrate === "shown") return c;
      c.sc_power_celebrate = "pending";
      return c;
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ONBOARD_ACTION_TOKENS,
  ONBOARD_ACTIONS,
  HEARD_SOURCES,
  onboardBonusTokens,
  needsOnboarding,
  needsPowerCelebrate,
  statusPayload,
  saveHeard,
  claimAction,
  skipOnboarding,
  markOnboardingDone,
  markPowerCelebrateShown,
  markPowerCelebratePending,
  persistOnboardingRecord,
  loadOnboardingRecord,
  normalizeHeard,
  powerShareIntentUrl,
  REPO_URL,
  X_FOLLOW_URL,
  SITE_URL,
};
