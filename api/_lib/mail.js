/**
 * Transactional product email helpers (welcome / weekly / receipts).
 * Sends via Resend only (`RESEND_API_KEY`). From / reply-to:
 *   WELCOME_FROM_EMAIL (default "Arjun Shah <arjun@supercompress.dev>")
 *   WELCOME_REPLY_TO (default arjun@supercompress.dev)
 *
 * Deliverability: every email is sent as plain text plus a minimal HTML twin
 * (no images, buttons, fonts, tracking pixels or layout tables) so it reads
 * like a 1:1 note. Open/click tracking must stay OFF on the Resend domain
 * (see scripts/resend-disable-tracking.js).
 *
 * Campaign copy is NOT in the OSS tree. Load order:
 *   1. WEEKLY_TIPS_JSON / WEEKLY_SHIP_JSON env (Vercel)
 *   2. SUPERCOMPRESS_EMAIL_CONTENT_DIR/{weekly-tips,weekly-ship}.json
 *   3. Local api/_lib fallback seed + CHANGELOG-derived ship bullets
 */

const fs = require("fs");
const path = require("path");

// Person-style sender. Gmail weighs "a person wrote this" signals heavily when
// choosing Primary vs Promotions, so avoid brand/noreply identities here.
const DEFAULT_FROM =
  process.env.WELCOME_FROM_EMAIL || "Arjun Shah <arjun@supercompress.dev>";
const REPLY_TO = process.env.WELCOME_REPLY_TO || "arjun@supercompress.dev";
const SITE = "https://www.supercompress.dev";
const LOGO = `${SITE}/assets/img/logo-chevrons.png`;
// Match live site chrome (landing-chrome.css)
const BRAND = "#0566ff";
const BRAND_HOVER = "#0055df";
const BRAND_SOFT = "#eef4ff";
const INK = "#171717";
const MUTED = "#5c5a55";
const BG = "#f4f5f8";
const CARD = "#ffffff";
const BORDER = "#e6e7eb";

function parseJsonObject(raw) {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Tip entries need subject + tipBody (or tip_body) before we render a campaign. */
function isValidTipEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const subject = String(entry.subject || "").trim();
  const body = String(entry.tipBody || entry.tip_body || entry.body || "").trim();
  return subject.length >= 3 && body.length >= 8;
}

function sanitizeTipsCatalog(data) {
  if (!data || typeof data !== "object") return null;
  const seed = Array.isArray(data.seed) ? data.seed.filter(isValidTipEntry) : [];
  const byCampaign = {};
  if (data.byCampaign && typeof data.byCampaign === "object") {
    for (const [k, v] of Object.entries(data.byCampaign)) {
      if (isValidTipEntry(v)) byCampaign[k] = v;
    }
  }
  if (!seed.length && !Object.keys(byCampaign).length) return null;
  return { ...data, seed, byCampaign };
}

function isValidShipEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const subject = String(entry.subject || "").trim();
  const bullets = entry.bullets || entry.items;
  const hasBullets = Array.isArray(bullets) && bullets.some((b) => String(b || "").trim().length > 4);
  const body = String(entry.body || entry.digest || "").trim();
  return subject.length >= 3 && (hasBullets || body.length >= 8);
}

function sanitizeShipCatalog(data) {
  if (!data || typeof data !== "object") return null;
  const byCampaign = {};
  if (data.byCampaign && typeof data.byCampaign === "object") {
    for (const [k, v] of Object.entries(data.byCampaign)) {
      if (isValidShipEntry(v)) byCampaign[k] = v;
    }
  }
  // Accept either { campaigns: { id: entry } } or flat by-id maps used locally.
  if (data.campaigns && typeof data.campaigns === "object") {
    const campaigns = {};
    for (const [k, v] of Object.entries(data.campaigns)) {
      if (isValidShipEntry(v)) campaigns[k] = v;
    }
    if (!Object.keys(campaigns).length && !Object.keys(byCampaign).length) return null;
    return { ...data, campaigns, byCampaign };
  }
  // Pass through if it looks like a digest object with required fields.
  if (isValidShipEntry(data)) return data;
  // Or a map of week ids
  const keys = Object.keys(data).filter((k) => k !== "seed" && k !== "byCampaign" && k !== "campaigns");
  const flat = {};
  if (keys.length && keys.every((k) => typeof data[k] === "object")) {
    for (const k of keys) {
      if (isValidShipEntry(data[k])) flat[k] = data[k];
    }
  }
  if (!Object.keys(flat).length && !Object.keys(byCampaign).length) return null;
  return { ...data, ...flat, byCampaign };
}

function loadCampaignJson(envName, fileName) {
  const fromEnv = (process.env[envName] || "").trim();
  if (fromEnv) {
    const parsed = parseJsonObject(fromEnv);
    if (parsed) {
      const sanitized =
        envName === "WEEKLY_TIPS_JSON"
          ? sanitizeTipsCatalog(parsed)
          : envName === "WEEKLY_SHIP_JSON"
            ? sanitizeShipCatalog(parsed)
            : parsed;
      if (sanitized) return sanitized;
      console.warn(`${envName} failed schema validation — ignoring`);
    }
  }
  const dirs = [];
  const contentDir = (process.env.SUPERCOMPRESS_EMAIL_CONTENT_DIR || "").trim();
  if (contentDir) dirs.push(contentDir);
  // Local seed next to this module (gitignored ops copy via SUPERCOMPRESS_EMAIL_CONTENT_DIR).
  dirs.push(path.join(__dirname));
  for (const dir of dirs) {
    try {
      const raw = fs.readFileSync(path.join(dir, fileName), "utf8");
      const parsed = parseJsonObject(raw);
      if (!parsed) continue;
      const sanitized =
        envName === "WEEKLY_TIPS_JSON"
          ? sanitizeTipsCatalog(parsed)
          : envName === "WEEKLY_SHIP_JSON"
            ? sanitizeShipCatalog(parsed)
            : parsed;
      if (sanitized) return sanitized;
    } catch {
      /* try next */
    }
  }
  return null;
}

const FONT_SANS =
  "'Source Sans 3', 'Source Sans Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_SERIF = "Platypi, Georgia, 'Times New Roman', serif";

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


/** Strip em/en dashes and arrows so copy reads like a hand-written note. */
function plainCopy(s) {
  return String(s == null ? "" : s)
    .replace(/[ \t]*[\u2014\u2013][ \t]*/g, ", ")
    .replace(/^, /gm, "")
    .replace(/[ \t]*[\u2192\u2190][ \t]*/g, " ")
    .replace(/\u2022/g, "-")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Minimal HTML twin of a plain-text email: no images, buttons, styles, fonts
 * or tables. Mirrors what Gmail itself produces for a personal message.
 */
function textToMinimalHtml(text) {
  const linkify = (line) =>
    escapeHtml(line).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  const paras = String(text || "")
    .split(/\n{2,}/)
    .map((p) => p.split("\n").map(linkify).join("<br>"))
    .map((p) => `<div>${p}</div><div><br></div>`)
    .join("");
  return `<div dir="ltr">${paras}</div>`;
}

/** One-line footer appended to every product email (CAN-SPAM / Gmail bulk rules). */
function footerLine(unsubUrl) {
  if (unsubUrl && String(unsubUrl).includes("http")) {
    return `You're getting this because you have a SuperCompress account. Unsubscribe: ${unsubUrl}`;
  }
  return "You're getting this because you have a SuperCompress account.";
}

/**
 * @deprecated Not used for sending (Promotions-tab signals). Kept for previews.
 * Branded email chrome — table layout for Gmail/Outlook.
 * Every product email (welcome, Sunday tip, Friday ship) goes through this.
 *
 * @param {{ preheader?: string, title?: string, bodyHtml: string, footerHtml?: string, unsubUrl?: string, kind?: string }} opts
 */
function brandedEmailHtml({
  preheader = "",
  title = "",
  bodyHtml,
  footerHtml = "",
  unsubUrl = "",
  kind = "",
}) {
  const pre = escapeHtml(preheader);
  const kindLabel =
    kind === "ship"
      ? "Product update"
      : kind === "tip"
        ? "Weekly tip"
        : kind === "welcome"
          ? "Welcome"
          : kind === "payment_thanks"
            ? "Thank you"
            : kind === "billing" || kind === "recharge"
              ? "Billing"
              : "";
  const kindChip = kindLabel
    ? `<span style="display:inline-block;margin-left:10px;padding:3px 9px;border-radius:999px;background:${BRAND_SOFT};color:${BRAND};font-family:${FONT_SANS};font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;vertical-align:middle;">${escapeHtml(kindLabel)}</span>`
    : "";
  const unsub =
    unsubUrl && String(unsubUrl).includes("http")
      ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:${MUTED};"><a href="${escapeHtml(unsubUrl)}" style="color:${MUTED};text-decoration:underline;">Unsubscribe from weekly emails</a></p>`
      : "";
  const foot = `${footerHtml || ""}${unsub}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
  <title>${escapeHtml(title || "SuperCompress")}</title>
  <!--[if !mso]><!-->
  <link href="https://fonts.googleapis.com/css2?family=Platypi:wght@400;500&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet" />
  <!--<![endif]-->
</head>
<body style="margin:0;padding:0;background:${BG};color:${INK};font-family:${FONT_SANS};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${pre}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 12px;font-family:${FONT_SANS};">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:${CARD};border:1px solid ${BORDER};border-radius:14px;overflow:hidden;font-family:${FONT_SANS};box-shadow:0 1px 2px rgba(23,23,23,0.04);">
          <tr>
            <td style="height:4px;background:${BRAND};font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:22px 28px 18px;border-bottom:1px solid ${BORDER};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img src="${LOGO}" width="28" height="28" alt="SuperCompress" style="display:inline-block;vertical-align:middle;border:0;" />
                    <span style="display:inline-block;vertical-align:middle;margin-left:10px;font-family:${FONT_SERIF};font-size:20px;font-weight:500;letter-spacing:-0.02em;color:${INK};">Super<span style="color:${BRAND};">Compress</span></span>
                    ${kindChip}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:30px 28px 10px;font-family:${FONT_SANS};font-size:16px;line-height:1.65;color:${INK};">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:4px 28px 28px;">
              ${foot}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px;background:#fafbfd;border-top:1px solid ${BORDER};font-size:12px;line-height:1.55;color:${MUTED};font-family:${FONT_SANS};">
              <strong style="color:${INK};font-weight:600;">SuperCompress</strong> · query-aware prompt compression<br />
              <a href="${SITE}" style="color:${BRAND};text-decoration:none;">supercompress.dev</a>
              · Reply anytime — Arjun reads every email.
            </td>
          </tr>
        </table>
        <p style="margin:16px 0 0;font-size:11px;line-height:1.5;color:#9a9a96;font-family:${FONT_SANS};">
          You’re getting this because you have a SuperCompress account.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(label, url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 10px;">
  <tr>
    <td style="background:${BRAND};border-radius:8px;">
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 22px;font-family:${FONT_SANS};font-size:15px;font-weight:700;letter-spacing:0.01em;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

function eyebrow(text) {
  return `<p style="margin:0 0 8px;font-family:${FONT_SANS};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND};">${escapeHtml(text)}</p>`;
}

function displayHeadline(text) {
  return `<p style="margin:0 0 16px;font-family:${FONT_SERIF};font-size:26px;line-height:1.28;font-weight:500;letter-spacing:-0.025em;color:${INK};">${escapeHtml(text)}</p>`;
}

function proofCallout(text) {
  return `<p style="margin:0 0 12px;padding:14px 16px;background:${BRAND_SOFT};border-left:3px solid ${BRAND};border-radius:0 8px 8px 0;font-size:14px;line-height:1.55;color:${INK};">${escapeHtml(text)}</p>`;
}

function signatureBlock() {
  return `<p style="margin:28px 0 0;font-size:15px;line-height:1.55;">— <strong>Arjun</strong><br /><span style="color:${MUTED};">Founder, SuperCompress</span></p>`;
}

/** Split "Title — detail" ship bullets into headline + body for marketing cards. */
function splitShipBullet(raw) {
  const text = String(raw || "").trim();
  const parts = text.split(/\s+[—–-]\s+/);
  if (parts.length >= 2) {
    return { title: parts[0].trim(), detail: parts.slice(1).join(" — ").trim() };
  }
  const colon = text.match(/^([^:]{8,48}):\s+(.+)$/);
  if (colon) return { title: colon[1].trim(), detail: colon[2].trim() };
  return { title: text, detail: "" };
}

function shipBulletCards(bullets) {
  return bullets
    .slice(0, 6)
    .map((b) => {
      const { title, detail } = splitShipBullet(b);
      return `<tr>
  <td style="padding:0 0 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafbfd;border:1px solid ${BORDER};border-radius:10px;">
      <tr>
        <td style="padding:14px 16px;">
          <p style="margin:0;font-family:${FONT_SANS};font-size:15px;font-weight:700;line-height:1.35;color:${INK};">${escapeHtml(title)}</p>
          ${
            detail
              ? `<p style="margin:6px 0 0;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(detail)}</p>`
              : ""
          }
        </td>
      </tr>
    </table>
  </td>
</tr>`;
    })
    .join("");
}

function welcomeCopy({ firstName, email }) {
  const hi = firstName ? `Hi ${firstName}` : "Hi";
  const subject = firstName ? `${firstName}, quick question` : "Quick question";
  const text = plainCopy(`${hi},

I'm Arjun, I build SuperCompress. I saw you signed up, thank you.

How is it going so far? If anything is confusing or missing, just reply to this email. I read every reply myself and I'm happy to help you get set up.

If you use Cursor or Claude Code, this is the quickest start:
npm install -g supercompress-proxy && supercompress setup

Setup guide: ${SITE}/docs/coding-agents

Arjun`);
  return { subject, text, html: textToMinimalHtml(text), to: email };
}

/** Minimal product fallback when private campaign JSON is unavailable. */
const WEEKLY_TIPS_FALLBACK = [
  {
    id: "agents-money",
    subject: "Your coding agent is burning tokens you can reclaim",
    tipTitle: "Stop paying for every log dump in Cursor / Claude Code",
    tipBody:
      "Agents re-send huge context every turn. SuperCompress installs as MCP, keeps your login, and trims tool dumps before they hit the model.",
    proof: "You install it once and it works with Cursor, Claude Code, Codex and others.",
    ctaLabel: "Setup guide",
    ctaUrl: `${SITE}/docs/coding-agents`,
    command: "npm install -g supercompress-proxy && supercompress setup",
    secondaryLabel: "See held-out benchmarks",
    secondaryUrl: `${SITE}/benchmarks`,
  },
];

function loadWeeklyTipsFile() {
  return loadCampaignJson("WEEKLY_TIPS_JSON", "weekly-tips.json");
}

function getWeeklyTipsCatalog() {
  const data = loadWeeklyTipsFile();
  const seed =
    Array.isArray(data?.seed) && data.seed.length
      ? data.seed
      : WEEKLY_TIPS_FALLBACK;
  const byCampaign =
    data?.byCampaign && typeof data.byCampaign === "object" ? data.byCampaign : {};
  return { seed, byCampaign };
}

/** Prefer campaign-specific tip (new each week). Seed is preview/dev only — never mass-send a recycled seed for a dated -tip campaign. */
function weeklyTipForCampaign(campaignId) {
  const { seed, byCampaign } = getWeeklyTipsCatalog();
  const cid = String(campaignId || "").trim();
  const base = cid.replace(/-(tip|ship)$/i, "");
  if (cid && byCampaign[cid] && byCampaign[cid].subject) {
    return { ...byCampaign[cid], campaign_id: cid };
  }
  if (base && byCampaign[base] && byCampaign[base].subject) {
    return { ...byCampaign[base], campaign_id: cid || base };
  }
  // Dated tip campaigns must be authored uniquely each week (private content + WEEKLY_TIPS_JSON).
  if (/-tip$/i.test(cid)) {
    return null;
  }
  const n = (cid || base).split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return seed[n % seed.length];
}

/** @deprecated use getWeeklyTipsCatalog().seed — kept for older callers */
const WEEKLY_TIPS = getWeeklyTipsCatalog().seed;

function weeklyCopy({ firstName, email, campaignId, unsubUrl }) {
  const tip = weeklyTipForCampaign(campaignId);
  const unsub = unsubUrl || `${SITE}/unsubscribe`;
  if (!tip || !tip.subject) {
    return {
      subject: null,
      text: null,
      html: null,
      to: email,
      tip_id: null,
      kind: "tip",
      unsubUrl: unsub,
      error: `missing_unique_tip:${campaignId || ""}`,
    };
  }
  const hi = firstName ? `Hi ${firstName}` : "Hi";
  const subject = plainCopy(tip.subject);
  const label = String(tip.ctaLabel || "Link").replace(/[\u2192>]/g, "").trim();
  // One link only (plus the unsubscribe footer the sender appends).
  const text = plainCopy(`${hi},

${tip.tipTitle || ""}

${tip.tipBody || ""}

${tip.proof || ""}

${tip.command || ""}

${tip.ctaUrl ? `${label}: ${tip.ctaUrl}` : ""}

If you try it, reply and tell me how it went.

Arjun`);
  return { subject, text, html: textToMinimalHtml(text), to: email, tip_id: tip.id, unsubUrl: unsub };
}

async function sendViaResend({
  to,
  subject,
  text,
  from = DEFAULT_FROM,
  unsubUrl,
  listUnsubscribeUrl,
  idempotencyKey,
}) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, provider: "resend", error: "RESEND_API_KEY not configured" };
  }

  // Always send plain text + a minimal HTML twin built from it. Any rich `html`
  // a caller passes is ignored on purpose: logos, buttons, web fonts and
  // layout tables are top Gmail Promotions signals.
  const body = `${plainCopy(text)}\n\n--\n${footerLine(unsubUrl || listUnsubscribeUrl)}`;
  const html = textToMinimalHtml(body);

  const headers = {};
  const oneClickUrl = listUnsubscribeUrl || unsubUrl;
  if (oneClickUrl && String(oneClickUrl).includes("http")) {
    // One-click List-Unsubscribe (RFC 8058). Required by Gmail for bulk senders.
    headers["List-Unsubscribe"] = `<${oneClickUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const reqHeaders = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) {
    reqHeaders["Idempotency-Key"] = String(idempotencyKey).slice(0, 256);
  }

  let res;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: reqHeaders,
      signal: AbortSignal.timeout(20000),
      // No `tags`: keep marketing/category metadata off product mail.
      body: JSON.stringify({
        from,
        to: [to],
        subject: plainCopy(subject),
        text: body,
        html,
        reply_to: REPLY_TO,
        headers,
      }),
    });
  } catch {
    return { ok: false, provider: "resend", error: "resend_request_failed" };
  }

  const resBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      provider: "resend",
      error: resBody?.message || resBody?.error || `HTTP ${res.status}`,
    };
  }
  return { ok: true, provider: "resend", id: resBody?.id || null };
}

async function sendWelcomeEmail({ email, firstName, idempotencyKey }) {
  if (!email || !String(email).includes("@")) {
    return { ok: false, error: "missing email" };
  }
  const copy = welcomeCopy({ firstName, email: String(email).trim() });
  const result = await sendViaResend({
    ...copy,
    idempotencyKey: idempotencyKey || null,
  });
  return { ...result, subject: copy.subject, text: copy.text, html: copy.html };
}

/**
 * Heartfelt founder thank-you after a successful prepaid credit purchase.
 * Auto-recharge charges should not use this — only intentional Checkout pays.
 */
function paymentThankYouCopy({ firstName, email, creditUsd, autoRecharge }) {
  const hi = firstName ? `Hey ${firstName}` : "Hey";
  const amount = Number(creditUsd);
  const amountLabel =
    Number.isFinite(amount) && amount > 0 ? `$${amount.toFixed(amount % 1 ? 2 : 0)}` : null;
  const subject = firstName ? `${firstName}, thank you` : "Thank you";
  const text = plainCopy(`${hi},

It's Arjun from SuperCompress. I just saw your payment come through${amountLabel ? ` (${amountLabel})` : ""}, thank you. Every person who backs SuperCompress with real money is a big deal to me.

If anything feels off, confusing or missing, or you just wish it did X, hit reply. I read every note myself.

${autoRecharge ? "Auto-recharge is on, so you shouldn't hit a wall mid-session. You can change that anytime in Billing.\n\n" : ""}Dashboard: ${SITE}/dashboard

Arjun`);
  return { subject, text, html: textToMinimalHtml(text), to: email };
}

async function sendPaymentThankYouEmail({
  email,
  firstName,
  creditUsd,
  autoRecharge,
  idempotencyKey,
}) {
  if (!email || !String(email).includes("@")) {
    return { ok: false, error: "missing email" };
  }
  const copy = paymentThankYouCopy({
    firstName,
    email: String(email).trim(),
    creditUsd,
    autoRecharge: Boolean(autoRecharge),
  });
  const result = await sendViaResend({
    ...copy,
    idempotencyKey: idempotencyKey || null,
  });
  return { ...result, subject: copy.subject, text: copy.text, html: copy.html };
}

/**
 * Auto-recharge could not finish silently — ask customer to confirm Checkout.
 * Always use branded chrome (logo / CTA / signature). Do not send raw div HTML.
 */
function autoRechargeRecoveryCopy({
  email,
  firstName,
  amount,
  checkoutUrl,
  reason,
}) {
  const hi = firstName ? `Hey ${firstName}` : "Hey";
  const amtNum = Number(amount);
  const amt =
    Number.isFinite(amtNum) && amtNum > 0
      ? `$${amtNum.toFixed(amtNum % 1 ? 2 : 0)}`
      : "your prepaid pack";
  const why =
    reason === "india_requires_checkout"
      ? "your card is issued in India, so RBI rules require a one-tap confirm for each top-up (we cannot silently debit it)."
      : reason === "no_payment_method"
        ? "we don't have a card on file that can complete auto-recharge."
        : reason === "authentication_required" ||
            /requires_action|requires_confirmation/i.test(String(reason || ""))
          ? "your bank asked for an extra confirmation (3-D Secure / mandate), so the silent charge could not finish."
          : "the silent auto-recharge charge could not complete.";
  const subject = `Confirm ${amt} SuperCompress recharge to keep compressing`;
  const billingUrl = `${SITE}/dashboard#billing`;
  const safeCheckout = String(checkoutUrl || billingUrl).trim();
  const text = plainCopy(`${hi},

It's Arjun from SuperCompress. Your prepaid balance hit $0 and auto-recharge is on, but ${why}

Confirm ${amt} recharge here to resume right away:
${safeCheckout}

Nothing was charged for the failed silent attempts. This checkout is the real top-up.

Arjun`);
  return { subject, text, html: textToMinimalHtml(text), to: email };
}

async function sendAutoRechargeRecoveryEmail({
  email,
  firstName,
  amount,
  checkoutUrl,
  reason,
  idempotencyKey,
}) {
  if (!email || !String(email).includes("@")) {
    return { ok: false, error: "missing email" };
  }
  if (!checkoutUrl || !String(checkoutUrl).startsWith("http")) {
    return { ok: false, error: "missing checkout url" };
  }
  const copy = autoRechargeRecoveryCopy({
    email: String(email).trim(),
    firstName,
    amount,
    checkoutUrl: String(checkoutUrl).trim(),
    reason,
  });
  const result = await sendViaResend({
    ...copy,
    idempotencyKey: idempotencyKey || null,
  });
  return { ...result, subject: copy.subject, text: copy.text, html: copy.html };
}

/**
 * Power-user email when someone newly crosses 1M tokens.
 * Rank/leaderboard lines are optional (omit for the automatic trigger).
 * @param {{ firstName?: string, email: string, rank?: number, tokensIn?: number, tokensSaved?: number, requests?: number, morePct?: number, cutPct?: number }} opts
 */
function powerUserCopy({
  firstName,
  email,
  rank,
  tokensIn,
  tokensSaved,
  requests,
  morePct,
  cutPct,
}) {
  const hi = firstName ? `Hey ${firstName}` : "Hey";
  const subject = firstName
    ? `${firstName}, you just crossed 1M tokens`
    : "You just crossed 1M tokens";
  const billingUrl = `${SITE}/dashboard?panel=billing`;
  const tin = Number(tokensIn || 0);
  const saved = Number(tokensSaved || 0);
  const reqs = Number(requests || 0);
  const more = Number(morePct || 0);
  const cut = Number(cutPct || 0);
  const hasRank = Number(rank) > 0;
  const fmt = (n) => {
    const v = Number(n || 0);
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
    return String(Math.round(v));
  };
  const ordinal = (n) => {
    const v = Number(n) || 0;
    const mod100 = v % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
    switch (v % 10) {
      case 1:
        return `${v}st`;
      case 2:
        return `${v}nd`;
      case 3:
        return `${v}rd`;
      default:
        return `${v}th`;
    }
  };
  const leadText = hasRank
    ? `You've crossed a million tokens on SuperCompress. That puts you ${ordinal(rank)} on the all-time leaderboard.`
    : "You've crossed a million tokens on SuperCompress. That makes you one of our heaviest users.";
  const statsLines = [];
  if (tin > 0) statsLines.push(`${fmt(tin)} tokens in`);
  if (saved > 0) statsLines.push(`${fmt(saved)} tokens saved${cut > 0 ? ` (about ${cut}% cut)` : ""}`);
  if (reqs > 0) statsLines.push(`${fmt(reqs)} requests`);
  if (more > 0) statsLines.push(`about ${more}% more usage from the same context budget`);
  const text = plainCopy(`${hi},

${leadText}

${statsLines.length ? `Your numbers so far: ${statsLines.join("; ")}.` : ""}

So the free monthly allowance doesn't cut off a session, you can load credits from Billing whenever you want:
${billingUrl}

I'd love to hear what you're using it for. Just reply.

Arjun`);
  return { subject, text, html: textToMinimalHtml(text), to: email };
}

async function sendPowerUserEmail(opts) {
  if (!opts?.email || !String(opts.email).includes("@")) {
    return { ok: false, error: "missing email" };
  }
  const copy = powerUserCopy(opts);
  const result = await sendViaResend({
    ...copy,
    idempotencyKey: opts.idempotencyKey || null,
  });
  return { ...result, subject: copy.subject, text: copy.text, html: copy.html };
}

/**
 * Monthly quota/upgrade email with actual allowance usage. Distinct from the
 * once-ever power-user congratulations; does not imply a blocked request.
 * @param {{ email: string, firstName?: string, tokensUsed?: number, freeTokens?: number, month?: string }} opts
 */
function quotaExhaustedCopy({ email, firstName, tokensUsed, freeTokens, month, unsubUrl, followupStage = 0 }) {
  const hi = firstName ? `Hey ${firstName}` : "Hey";
  const billingUrl = `${SITE}/dashboard?panel=billing`;
  const free = Number(freeTokens || require("./stripe").FREE_TOKENS_PER_MONTH);
  const used = Math.max(0, Number(tokensUsed) || 0);
  const remaining = Math.max(0, free - used);
  const exhausted = remaining === 0;
  const freeM = (free / 1e6).toFixed(free % 1e6 === 0 ? 0 : 1);
  const usedM = (used / 1e6).toFixed(2);
  const subject = followupStage === 2 ? "Last note about your SuperCompress allowance" : followupStage === 1 ? "A quick check on your SuperCompress allowance" : exhausted
    ? "Your free SuperCompress allowance is used up"
    : "Your SuperCompress allowance this month";
  const usageLine = exhausted
    ? `You've used your free ${freeM}M tokens this month (${usedM}M so far). Add credits to keep compressing, or wait for your free allowance to reset.`
    : `You've compressed ${used.toLocaleString("en-US")} tokens this month. You have ${remaining.toLocaleString("en-US")} of your ${free.toLocaleString("en-US")} free monthly tokens remaining. You can keep using that allowance without paying.`;
  let resetLine = "Your free allowance resets on the 1st of next month.";
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (m) {
    const next = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
    const label = next.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    resetLine = `Your free allowance resets on ${label}.`;
  }
  const text = plainCopy(`${hi},

${usageLine}

${followupStage === 2 ? "This is my last follow-up about this." : ""}

${resetLine} Waiting is fine, your keys and integrations stay put. If you'd rather not lose a session, you can add credits in Billing:
${billingUrl}

Any questions, just reply.

Arjun`);
  return { subject, text, html: textToMinimalHtml(text), to: email };
}

async function sendQuotaExhaustedEmail(opts) {
  if (!opts?.email || !String(opts.email).includes("@")) {
    return { ok: false, error: "missing email" };
  }
  const copy = quotaExhaustedCopy(opts);
  const result = await sendViaResend({
    ...copy,
    idempotencyKey: opts.idempotencyKey || null,
    unsubUrl: opts.unsubUrl,
    listUnsubscribeUrl: opts.listUnsubscribeUrl,
  });
  return { ...result, subject: copy.subject, text: copy.text, html: copy.html };
}

/**
 * Branded password reset (Resend) — replaces Firebase's unbranded auth email.
 */
function passwordResetCopy({ email, resetUrl, firstName, intent = "reset" }) {
  const hi = firstName ? `Hey ${firstName}` : "Hey";
  const isChange = String(intent || "").toLowerCase() === "change";
  const subject = isChange ? "Change your SuperCompress password" : "Reset your SuperCompress password";
  const verb = isChange ? "change" : "reset";
  const text = plainCopy(`${hi},

Someone requested a password ${verb} for your SuperCompress account (${email}).

${isChange ? "Set new password" : "Reset password"} (link expires in about an hour):
${resetUrl}

If you didn't ask for this, you can ignore this email and your password stays the same.

Arjun`);
  return { subject, text, html: textToMinimalHtml(text), to: email };
}

async function sendPasswordResetEmail({ email, resetUrl, firstName, idempotencyKey, intent = "reset" }) {
  if (!email || !String(email).includes("@") || !resetUrl) {
    return { ok: false, error: "missing email or resetUrl" };
  }
  const copy = passwordResetCopy({
    email: String(email).trim(),
    resetUrl: String(resetUrl).trim(),
    firstName,
    intent,
  });
  const result = await sendViaResend({
    ...copy,
    idempotencyKey: idempotencyKey || null,
  });
  return { ...result, subject: copy.subject };
}

function campaignKind(campaignId) {
  const id = String(campaignId || "");
  if (id.includes("launch-v2")) return "launch";
  if (id.endsWith("-ship") || id.includes("-ship")) return "ship";
  return "tip";
}

/**
 * Parse Keep-a-Changelog sections with dates in the last `withinDays`.
 * Returns { versions: [{version, date, body}], bullets: string[] }.
 */
function parseRecentChangelog(markdown, withinDays = 10) {
  const text = String(markdown || "");
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  const sectionRe =
    /^##\s+\[([^\]]+)\]\s*(?:—|-|–)\s*(\d{4}-\d{2}-\d{2})\s*$/gm;
  const matches = [];
  let m;
  while ((m = sectionRe.exec(text)) !== null) {
    matches.push({
      version: m[1],
      date: m[2],
      index: m.index,
      headerEnd: m.index + m[0].length,
    });
  }
  const versions = [];
  const bullets = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const ts = Date.parse(cur.date);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    if (/^unreleased$/i.test(cur.version)) continue;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(cur.headerEnd, end).trim();
    versions.push({ version: cur.version, date: cur.date, body });
    const lines = body.split("\n");
    for (const line of lines) {
      const bullet = line.match(/^\s*[-*]\s+\*?\*?(.+?)\*?\*?\s*$/);
      if (bullet) {
        const cleaned = bullet[1]
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1")
          .trim();
        if (cleaned && cleaned.length > 8) bullets.push(cleaned);
      }
    }
  }
  return { versions, bullets };
}

function loadWeeklyShipFile() {
  return loadCampaignJson("WEEKLY_SHIP_JSON", "weekly-ship.json");
}

function loadShipDigest(withinDays = 10, campaignId = "") {
  const cid = String(campaignId || "").trim();
  const shipFile = loadWeeklyShipFile();
  const by = shipFile?.byCampaign && typeof shipFile.byCampaign === "object" ? shipFile.byCampaign : null;
  let entry = cid && by ? by[cid] : null;
  if ((!entry || !entry.bullets?.length) && cid && by) {
    const hit = Object.keys(by).find((k) => k.toLowerCase() === cid.toLowerCase());
    if (hit) entry = by[hit];
  }
  if (entry?.bullets?.length) {
    return {
      versions: (entry.versions || []).map((v) => ({ version: v, date: "", body: "" })),
      bullets: entry.bullets.slice(0, 10),
      subject: entry.subject || "",
      headline: entry.headline || "",
      intro: entry.intro || "",
    };
  }

  const roots = [
    path.join(__dirname, "..", "..", "CHANGELOG.md"),
    path.join(__dirname, "..", "..", "packages", "proxy", "CHANGELOG.md"),
  ];
  const seen = new Set();
  const versions = [];
  const bullets = [];
  for (const file of roots) {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseRecentChangelog(raw, withinDays);
    for (const v of parsed.versions) {
      const key = `${v.version}|${v.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      versions.push(v);
    }
    for (const b of parsed.bullets) {
      if (seen.has(`b:${b}`)) continue;
      seen.add(`b:${b}`);
      bullets.push(b);
    }
  }
  versions.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // Fallback: latest campaign entry in weekly-ship.json
  if (!bullets.length && shipFile?.byCampaign) {
    const keys = Object.keys(shipFile.byCampaign).sort().reverse();
    for (const key of keys) {
      const entry = shipFile.byCampaign[key];
      if (entry?.bullets?.length) {
        return {
          versions: (entry.versions || []).map((v) => ({ version: v, date: "", body: "" })),
          bullets: entry.bullets.slice(0, 10),
          subject: entry.subject || "",
          headline: entry.headline || "",
          intro: entry.intro || "",
        };
      }
    }
  }

  return {
    versions,
    bullets: bullets.slice(0, 8),
    subject: "",
    headline: "",
    intro: "",
  };
}

function shipCopy({ firstName, email, campaignId, unsubUrl }) {
  const hi = firstName ? `Hi ${firstName}` : "Hi";
  const unsub = unsubUrl || `${SITE}/unsubscribe`;
  const digest = loadShipDigest(10, campaignId);
  const intro =
    digest.intro ||
    "Quick update on what I changed in SuperCompress this week:";
  const subject = digest.subject || "What I changed in SuperCompress this week";
  const bullets = digest.bullets.length
    ? digest.bullets
    : [
        "Setup: linking Cursor, Claude or your API key is clearer when something goes wrong",
        "Agents: compression is more likely to actually run on big tool dumps",
        "Reliability: fewer silent fails when streaming long replies",
      ];
  const text = plainCopy(`${hi},

${digest.headline ? `${digest.headline}\n\n` : ""}${intro}

${bullets.slice(0, 6).map((b) => `- ${b}`).join("\n")}

If any of this breaks for you, or there's something you want next, just reply.

Arjun`);
  return {
    subject: plainCopy(subject),
    text,
    html: textToMinimalHtml(text),
    to: email,
    tip_id: `ship-${campaignId || "week"}`,
    kind: "ship",
    unsubUrl: unsub,
    versions: digest.versions.map((v) => v.version),
  };
}

function weeklyEmailCopy(opts) {
  const kind = campaignKind(opts.campaignId);
  if (kind === "launch") {
    return launchV2Copy(opts);
  }
  if (kind === "ship") {
    return shipCopy(opts);
  }
  return weeklyCopy(opts);
}

async function sendWeeklyEmail({ email, firstName, campaignId, unsubUrl, listUnsubscribeUrl }) {
  if (!email || !String(email).includes("@")) {
    return { ok: false, error: "missing email" };
  }
  const copy = weeklyEmailCopy({
    firstName,
    email: String(email).trim(),
    campaignId,
    unsubUrl,
  });
  if (copy.error || !copy.subject || !copy.html) {
    return {
      ok: false,
      error: copy.error || "missing_email_copy",
      subject: copy.subject,
      tip_id: copy.tip_id,
      kind: copy.kind || campaignKind(campaignId),
    };
  }
  const result = await sendViaResend({
    ...copy,
    unsubUrl: copy.unsubUrl || unsubUrl,
    listUnsubscribeUrl,
  });
  return {
    ...result,
    subject: copy.subject,
    text: copy.text,
    html: copy.html,
    tip_id: copy.tip_id,
    kind: copy.kind || campaignKind(campaignId),
  };
}

function launchV2Copy({ firstName, unsubUrl } = {}) {
  const hi = firstName ? `Hi ${firstName}` : "Hi";
  const unsub = unsubUrl || `${SITE}/unsubscribe`;
  const subject = "SuperCompress v2 is out";
  const text = plainCopy(`${hi},

I just shipped SuperCompress v2.

It's a 400M-parameter engine that looks at all of your context, figures out what's relevant to the query, and cuts the rest. It is strongest on coding-agent dumps (tool output, logs, diffs, stack traces) where the answer is a few original lines. It keeps those lines as they are, and the question itself is never compressed.

On our coding-agent benchmark, v2 cut context by 64.1% on average and kept the required evidence in 24/24 cases.

Get an API key: ${SITE}/dashboard?signup=1
Agent plugin setup: https://docs.supercompress.dev/coding-agents

Would love to hear what you think, just reply.

Arjun`);
  return {
    subject,
    text,
    html: textToMinimalHtml(text),
    tip_id: "launch-v2-2026-09-29",
    kind: "ship",
    unsubUrl: unsub,
  };
}

module.exports = {
  welcomeCopy,
  launchV2Copy,
  powerUserCopy,
  quotaExhaustedCopy,
  paymentThankYouCopy,
  autoRechargeRecoveryCopy,
  passwordResetCopy,
  weeklyCopy,
  shipCopy,
  weeklyEmailCopy,
  campaignKind,
  loadShipDigest,
  parseRecentChangelog,
  weeklyTipForCampaign,
  WEEKLY_TIPS,
  brandedEmailHtml,
  textToMinimalHtml,
  plainCopy,
  footerLine,
  sendViaResend,
  sendWelcomeEmail,
  sendPowerUserEmail,
  sendQuotaExhaustedEmail,
  sendPaymentThankYouEmail,
  sendAutoRechargeRecoveryEmail,
  sendPasswordResetEmail,
  sendWeeklyEmail,
  DEFAULT_FROM,
};
