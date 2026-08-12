/**
 * Affiliate program API — consolidated.
 *
 * POST /api/affiliates                 → Register a new affiliate (form signup)
 * POST /api/affiliates (action:track)  → Log a referral visit
 * POST /api/affiliates (action:claim)  → Claim a conversion
 * POST /api/affiliates (action:register) → Register via internal dashboard (Firebase auth)
 *
 * GET  /api/affiliates                 → List all affiliates
 * GET  /api/affiliates?view=me         → Current user's stats (Firebase auth required)
 * GET  /api/affiliates?view=admin      → Founder admin view (founder auth required)
 */

const crypto = require("crypto");
const { json, readBody, softProbe } = require("./_lib/http");
const { loadStore, mutateStore } = require("./_lib/store");
const { verifyUser } = require("./_lib/auth");

const REF_BASE = "https://supercompress.dev";
const FOUNDER_EMAILS = new Set(
  String(process.env.FOUNDER_ADMIN_EMAILS || "arjunkshah21@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const PLAN_PRICES = { starter: 1000, pro: 2000, business: 6000 };

/* ── Helpers ── */

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .replace(/^[0-9]+/, "")
      .slice(0, 40) || "affiliate"
  );
}

async function uniqueSlug(baseSlug) {
  const store = await loadStore();
  const affiliates = store.affiliates || {};
  const existingSlugs = new Set(
    Object.values(affiliates).map((a) => a.referral_slug)
  );
  if (!existingSlugs.has(baseSlug)) return baseSlug;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${baseSlug}${i}`;
    if (!existingSlugs.has(candidate)) return candidate;
  }
  return `${baseSlug}-${crypto.randomBytes(2).toString("hex")}`;
}

async function validateSlug(slug) {
  const store = await loadStore();
  const affiliates = store.affiliates || {};
  return (
    Object.values(affiliates).find(
      (a) => a.referral_slug === slug && a.status === "active"
    ) || null
  );
}

function clientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function computeAffiliateStats(affiliate, tracking, conversions) {
  const slug = affiliate.referral_slug;
  const visits = Object.values(tracking).filter((v) => v.ref === slug);
  const uniqueIps = new Set(visits.map((v) => v.ip));
  const claims = Object.values(conversions).filter((c) => c.ref === slug);
  const pendingPayouts = claims.filter((c) => c.status === "pending");
  const confirmedPayouts = claims.filter((c) => c.status === "confirmed");
  const totalPendingCents = pendingPayouts.length * 800;
  const totalPaidCents = confirmedPayouts.length * 800;

  return {
    total_visits: visits.length,
    unique_visitors: uniqueIps.size,
    total_conversions: claims.length,
    pending_conversions: pendingPayouts.length,
    confirmed_conversions: confirmedPayouts.length,
    pending_payout_cents: totalPendingCents,
    paid_out_cents: totalPaidCents,
    pending_payout_dollars: (totalPendingCents / 100).toFixed(2),
    paid_out_dollars: (totalPaidCents / 100).toFixed(2),
    commission_pct: 40,
    recent_conversions: claims
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 10),
  };
}

/* ── Route handler ── */

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  /* ── POST ── */
  if (req.method === "POST") {
    const body = readBody(req);
    const action = body.action || "register";

    // Track a referral visit (fire-and-forget from affiliate-track.js)
    if (action === "track") {
      return handleTrack(req, res, body);
    }

    // Claim a conversion (from affiliate-claim.js)
    if (action === "claim") {
      return handleClaim(req, res, body);
    }

    // Internal dashboard registration (Firebase auth required)
    if (action === "internal") {
      return handleInternalRegister(req, res, body);
    }

    // Public registration (from affiliates.html)
    return handlePublicRegister(req, res, body);
  }

  /* ── GET ── */
  if (req.method === "GET") {
    const view =
      req.query?.view ||
      (req.url?.includes("view=admin")
        ? "admin"
        : req.url?.includes("view=me")
          ? "me"
          : "list");

    if (view === "admin") {
      return handleAdminView(req, res);
    }

    if (view === "me") {
      return handleMeView(req, res);
    }

    // Default: list all affiliates
    return handleList(req, res);
  }

  return softProbe(res, "Method not allowed", { allow: "GET, POST" });
};

/* ── Public register (from affiliates.html) ── */

async function handlePublicRegister(req, res, body) {
  try {
    const { name, email, website, audience } = body;
    if (!name || !email) {
      // Empty scanner POSTs — soft 200 (Observability error rate).
      return softProbe(res, "Name and email are required.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return softProbe(res, "Invalid email address.");
    }

    const cleanName = name.trim().slice(0, 120);
    const cleanEmail = email.trim().toLowerCase();
    const slug = await uniqueSlug(slugify(cleanName));
    const id = crypto.randomUUID();
    const refLink = `${REF_BASE}/?ref=${slug}`;

    const result = await mutateStore((store) => {
      if (!store.affiliates) store.affiliates = {};
      for (const existing of Object.values(store.affiliates)) {
        if (existing.email === cleanEmail) {
          const dupErr = new Error(
            "An affiliate account with this email already exists."
          );
          dupErr.status = 409;
          throw dupErr;
        }
      }
      store.affiliates[id] = {
        id,
        name: cleanName,
        email: cleanEmail,
        website: (website || "").trim().slice(0, 500),
        audience: (audience || "").trim().slice(0, 500),
        referral_slug: slug,
        referral_link: refLink,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return { id, slug, refLink };
    });

    return json(res, 200, {
      id: result.id,
      referral_slug: result.slug,
      referral_link: result.refLink,
      detail: "You're in! Share your referral link to start earning 40% recurring commission.",
    });
  } catch (err) {
    return json(res, err.status || 500, {
      detail: err.message || "Failed to create affiliate account.",
    });
  }
}

/* ── Track visit ── */

async function handleTrack(req, res, body) {
  try {
    const ref = (body.ref || "").trim().toLowerCase();
    if (!ref || ref.length < 2 || ref.length > 60) {
      return json(res, 200, { tracked: false });
    }
    const affiliate = await validateSlug(ref);
    const ip = clientIp(req);
    const visitId = `${ref}_${Date.now()}_${ip}`.replace(
      /[^a-zA-Z0-9_-]/g,
      "_"
    );

    await mutateStore((store) => {
      if (!store.affiliate_tracking) store.affiliate_tracking = {};
      store.affiliate_tracking[visitId] = {
        ref,
        ip,
        page: body.page || "/",
        referrer: body.referrer || null,
        user_agent: req.headers["user-agent"] || null,
        affiliate_exists: !!affiliate,
        ts: body.ts || new Date().toISOString(),
        logged_at: new Date().toISOString(),
      };
    });

    return json(res, 200, { tracked: true });
  } catch (err) {
    return json(res, 200, { tracked: false });
  }
}

/* ── Claim conversion ── */

async function handleClaim(req, res, body) {
  try {
    const ref = (body.ref || "").trim().toLowerCase();
    const userEmail = (body.user_email || "").trim().toLowerCase();
    const action = body.action_type || "signup";

    if (!ref || !userEmail) {
      return json(res, 400, {
        detail: "Both 'ref' and 'user_email' are required.",
      });
    }

    const affiliate = await validateSlug(ref);
    if (!affiliate) {
      return json(res, 404, { detail: "Affiliate not found or inactive." });
    }

    const store = await loadStore();
    const conversions = store.affiliate_conversions || {};
    for (const conv of Object.values(conversions)) {
      if (conv.user_email === userEmail && conv.ref === ref) {
        return json(res, 200, {
          claimed: true,
          duplicate: true,
          detail: "Referral already claimed.",
        });
      }
    }

    const claimId = `${ref}_${userEmail}_${Date.now()}`.replace(
      /[^a-zA-Z0-9_-]/g,
      "_"
    );

    await mutateStore((store) => {
      if (!store.affiliate_conversions) store.affiliate_conversions = {};
      store.affiliate_conversions[claimId] = {
        id: claimId,
        ref,
        affiliate_email: affiliate.email,
        affiliate_name: affiliate.name,
        user_email: userEmail,
        action,
        status: "pending",
        commission_pct: 40,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

    return json(res, 200, {
      claimed: true,
      ref,
      commission_pct: 40,
      detail: `Referral credited to ${affiliate.name}.`,
    });
  } catch (err) {
    return json(res, err.status || 500, {
      detail: err.message || "Failed to claim referral.",
    });
  }
}

/* ── Internal registration (Firebase auth required) ── */

async function handleInternalRegister(req, res, body) {
  try {
    const user = await verifyUser(req);
    const email = (user.email || "").toLowerCase().trim();
    const name = body.name || user.displayName || email.split("@")[0] || "Affiliate";
    const cleanName = name.trim().slice(0, 120);
    const baseSlug = slugify(cleanName);

    const store = await loadStore();
    const affiliates = store.affiliates || {};

    for (const a of Object.values(affiliates)) {
      if (a.email === email) {
        return json(res, 409, {
          detail: "You're already registered.",
          referral_link: a.referral_link,
          referral_slug: a.referral_slug,
        });
      }
    }

    const existingSlugs = new Set(
      Object.values(affiliates).map((a) => a.referral_slug)
    );
    let slug = baseSlug;
    if (existingSlugs.has(slug)) {
      for (let i = 1; i < 1000; i++) {
        const candidate = `${baseSlug}${i}`;
        if (!existingSlugs.has(candidate)) {
          slug = candidate;
          break;
        }
      }
    }

    const id = crypto.randomUUID();
    const refLink = `${REF_BASE}/?ref=${slug}`;

    const result = await mutateStore((store) => {
      if (!store.affiliates) store.affiliates = {};
      store.affiliates[id] = {
        id,
        name: cleanName,
        email,
        uid: user.uid,
        website: (body.website || "").trim().slice(0, 500),
        audience: (body.audience || "").trim().slice(0, 500),
        paypal_email: (body.paypal_email || "").trim().slice(0, 200),
        promote: (body.promote || "").trim().slice(0, 500),
        referral_slug: slug,
        referral_link: refLink,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return { id, slug, refLink };
    });

    return json(res, 200, {
      id: result.id,
      referral_slug: result.slug,
      referral_link: result.refLink,
      name: cleanName,
      commission_pct: 40,
      detail: "Welcome! Share your link to start earning.",
    });
  } catch (err) {
    return json(res, err.status || 500, {
      detail: err.message || "Failed to register.",
    });
  }
}

/* ── GET: List all affiliates ── */

async function handleList(req, res) {
  try {
    const store = await loadStore();
    const affiliates = store.affiliates || {};
    // Public list — no PII (email/website/audience). Founder admin view keeps full fields.
    const list = Object.values(affiliates).map((a) => ({
      id: a.id,
      name: a.name,
      referral_slug: a.referral_slug,
      referral_link: a.referral_link,
      status: a.status,
      created_at: a.created_at,
    }));
    return json(res, 200, { affiliates: list });
  } catch (err) {
    return json(res, err.status || 500, {
      detail: err.message || "Failed to list affiliates.",
    });
  }
}

/* ── GET: Me (current user stats, Firebase auth required) ── */

async function handleMeView(req, res) {
  try {
    const user = await verifyUser(req);
    const email = (user.email || "").toLowerCase().trim();
    const store = await loadStore();
    const affiliates = store.affiliates || {};
    const tracking = store.affiliate_tracking || {};
    const conversions = store.affiliate_conversions || {};

    const affiliate = Object.values(affiliates).find(
      (a) => a.email === email || a.uid === user.uid
    );

    if (!affiliate) {
      return json(res, 404, {
        detail: "No affiliate account found. Register first.",
        registered: false,
      });
    }

    const isFounder = FOUNDER_EMAILS.has(email);
    const stats = computeAffiliateStats(affiliate, tracking, conversions);

    return json(res, 200, { affiliate, stats, is_founder: isFounder });
  } catch (err) {
    return json(res, err.status || 500, {
      detail: err.message || "Failed to get stats.",
    });
  }
}

/* ── GET: Admin view (founder only) ── */

async function handleAdminView(req, res) {
  try {
    const user = await verifyUser(req);
    const email = (user.email || "").toLowerCase().trim();
    const isFounder = FOUNDER_EMAILS.has(email);

    if (!isFounder) {
      return json(res, 403, { detail: "Access denied. Founder access only." });
    }

    const store = await loadStore();
    const affiliates = store.affiliates || {};
    const tracking = store.affiliate_tracking || {};
    const conversions = store.affiliate_conversions || {};

    const list = Object.values(affiliates).map((a) => ({
      ...a,
      stats: computeAffiliateStats(a, tracking, conversions),
    }));

    const totalAffiliates = list.length;
    const totalVisits = list.reduce((s, a) => s + a.stats.total_visits, 0);
    const totalConversions = list.reduce(
      (s, a) => s + a.stats.total_conversions,
      0
    );
    const totalPendingCents = list.reduce(
      (s, a) => s + a.stats.pending_payout_cents,
      0
    );
    const totalPaidCents = list.reduce(
      (s, a) => s + a.stats.paid_out_cents,
      0
    );

    return json(res, 200, {
      summary: {
        total_affiliates: totalAffiliates,
        total_visits: totalVisits,
        total_conversions: totalConversions,
        pending_payout_cents: totalPendingCents,
        pending_payout_dollars: (totalPendingCents / 100).toFixed(2),
        paid_out_cents: totalPaidCents,
        paid_out_dollars: (totalPaidCents / 100).toFixed(2),
      },
      affiliates: list.sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      ),
    });
  } catch (err) {
    return json(res, err.status || 500, {
      detail: err.message || "Failed to load admin view.",
    });
  }
}
