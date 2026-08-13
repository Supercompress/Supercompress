/**
 * Transactional product email helpers (welcome / weekly / receipts).
 * Sends via Resend only (`RESEND_API_KEY`). From / reply-to:
 *   WELCOME_FROM_EMAIL (default hello@supercompress.dev on verified Resend domain)
 *   WELCOME_REPLY_TO (default founder Gmail)
 *
 * Campaign copy is NOT in the OSS tree. Canonical private repo:
 *   https://github.com/Supercompress/email-campaigns
 * Load order:
 *   1. WEEKLY_TIPS_JSON / WEEKLY_SHIP_JSON env (Vercel; sync from that repo)
 *   2. SUPERCOMPRESS_EMAIL_CONTENT_DIR/{weekly-tips,weekly-ship}.json
 *   3. ~/agent-bridge/private/supercompress-email/content/ (local mirror)
 *   4. Minimal fallback seed + CHANGELOG-derived ship bullets
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_FROM =
  process.env.WELCOME_FROM_EMAIL ||
  "Arjun at SuperCompress <hello@supercompress.dev>";
const REPLY_TO = process.env.WELCOME_REPLY_TO || "arjunkshah21@gmail.com";
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

const PRIVATE_EMAIL_CONTENT_DIR = path.join(
  os.homedir(),
  "agent-bridge",
  "private",
  "supercompress-email",
  "content"
);

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
  // Accept either { campaigns: { id: entry } } or flat by-id maps used locally.
  if (data.campaigns && typeof data.campaigns === "object") {
    const campaigns = {};
    for (const [k, v] of Object.entries(data.campaigns)) {
      if (isValidShipEntry(v)) campaigns[k] = v;
    }
    if (!Object.keys(campaigns).length) return null;
    return { ...data, campaigns };
  }
  // Pass through if it looks like a digest object with required fields.
  if (isValidShipEntry(data)) return data;
  // Or a map of week ids
  const keys = Object.keys(data).filter((k) => k !== "seed" && k !== "byCampaign");
  if (keys.length && keys.every((k) => typeof data[k] === "object")) {
    const out = {};
    for (const k of keys) {
      if (isValidShipEntry(data[k])) out[k] = data[k];
    }
    if (!Object.keys(out).length) return null;
    return out;
  }
  return null;
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
  dirs.push(PRIVATE_EMAIL_CONTENT_DIR);
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

/**
 * Branded email chrome — table layout for Gmail/Outlook.
 * Every product email (welcome, Sunday tip, Wednesday ship) goes through this.
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
  const subjectFinal = firstName
    ? `${firstName}, quick note from Arjun @ SuperCompress`
    : "Quick note from Arjun @ SuperCompress";

  const text = `${hi},

I'm Arjun, founder of SuperCompress. Saw you signed up — thanks, that means a lot.

How are you liking the product so far? Anything confusing, missing, or that you'd want next? Even a one-liner reply helps.

If you're stuck, just reply to this email and I'll help personally.

Get started:
• Dashboard: ${SITE}/dashboard
• Coding agents (Cursor / Claude Code): ${SITE}/docs/coding-agents
• Playground: ${SITE}/playground

One command for agents:
npm install -g supercompress-proxy && npx supercompress setup

Free: 1M tokens/month. Then $0.30 / 1M PAYG so you never hard-stop — usually cheaper than the LLM tokens you save.

Thanks again,
Arjun
Founder, SuperCompress
${REPLY_TO}`;

  const bodyHtml = `
<p style="margin:0 0 16px;font-size:16px;">${escapeHtml(hi)},</p>
${eyebrow("Welcome")}
${displayHeadline("Thanks for signing up")}
<p style="margin:0 0 16px;">I'm <strong>Arjun</strong>, founder of SuperCompress. Saw you signed up — that means a lot.</p>
<p style="margin:0 0 16px;">How are you liking it so far? Anything confusing, missing, or that you'd want next? Even a one-liner reply helps.</p>
<p style="margin:0 0 8px;">If you're stuck, <strong>reply to this email</strong> and I'll help personally.</p>
${ctaButton("Open your dashboard →", `${SITE}/dashboard`)}
<p style="margin:18px 0 8px;font-size:14px;color:${MUTED};">Or install for coding agents (keep your normal login):</p>
<pre style="margin:0 0 16px;padding:14px 16px;background:#0a0a0a;color:#e8e8e8;border-radius:8px;font-size:12px;line-height:1.55;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">npm install -g supercompress-proxy
npx supercompress setup</pre>
<p style="margin:0 0 8px;font-size:14px;">
  <a href="${SITE}/docs/coding-agents" style="color:${BRAND};text-decoration:none;font-weight:600;">Coding agents</a>
  · <a href="${SITE}/playground" style="color:${BRAND};text-decoration:none;font-weight:600;">Playground</a>
  · <a href="${SITE}/reduce-llm-costs" style="color:${BRAND};text-decoration:none;font-weight:600;">Cut API costs</a>
</p>
${proofCallout("Free: 1M tokens/month · then $0.30 / 1M PAYG so you never hard-stop.")}
${signatureBlock()}`;

  const html = brandedEmailHtml({
    preheader: "Thanks for signing up — how's SuperCompress so far? Reply anytime.",
    title: subjectFinal,
    bodyHtml,
    kind: "welcome",
  });

  return { subject: subjectFinal, text, html, to: email };
}

/** Minimal product fallback when private campaign JSON is unavailable. */
const WEEKLY_TIPS_FALLBACK = [
  {
    id: "agents-money",
    subject: "Your coding agent is burning tokens you can reclaim",
    tipTitle: "Stop paying for every log dump in Cursor / Claude Code",
    tipBody:
      "Agents re-send huge context every turn. SuperCompress installs as MCP, keeps your login, and compresses dumps before they hit the model — typically ~65% fewer input tokens with ≥98% answer keep on our held-out suites.",
    proof: "Install once. Works with Cursor, Claude Code, Codex, and more.",
    ctaLabel: "Install coding agent plugin →",
    ctaUrl: `${SITE}/docs/coding-agents`,
    command: "npm install -g supercompress-proxy && npx supercompress setup",
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

/** Prefer campaign-specific tip (new each week); else rotate seed. */
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
  const n = (cid || base).split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return seed[n % seed.length];
}

/** @deprecated use getWeeklyTipsCatalog().seed — kept for older callers */
const WEEKLY_TIPS = getWeeklyTipsCatalog().seed;

function weeklyCopy({ firstName, email, campaignId, unsubUrl }) {
  const hi = firstName ? `Hi ${firstName}` : "Hi";
  const tip = weeklyTipForCampaign(campaignId);
  const subject = tip.subject;
  const unsub = unsubUrl || `${SITE}/unsubscribe`;

  const cmdBlock = tip.command ? `\n${tip.command}\n` : "";
  const text = `${hi},

${tip.tipTitle}

${tip.tipBody}

${tip.proof}
${cmdBlock}
→ ${tip.ctaLabel.replace(/→/g, "").trim()}: ${tip.ctaUrl}
${tip.secondaryLabel ? `Also: ${tip.secondaryLabel}: ${tip.secondaryUrl}` : ""}

Dashboard: ${SITE}/dashboard

— Arjun
Founder, SuperCompress

Unsubscribe: ${unsub}
`;

  const cmdHtml = tip.command
    ? `<pre style="margin:16px 0;padding:14px 16px;background:#0a0a0a;color:#e8e8e8;border-radius:8px;font-size:12px;line-height:1.55;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(tip.command)}</pre>`
    : "";

  const bodyHtml = `
<p style="margin:0 0 16px;font-size:16px;">${escapeHtml(hi)},</p>
${eyebrow("Sunday tip")}
${displayHeadline(tip.tipTitle)}
<p style="margin:0 0 16px;">${escapeHtml(tip.tipBody)}</p>
${proofCallout(tip.proof)}
${cmdHtml}
${ctaButton(tip.ctaLabel, tip.ctaUrl)}
${
  tip.secondaryUrl
    ? `<p style="margin:12px 0 0;font-size:14px;"><a href="${escapeHtml(tip.secondaryUrl)}" style="color:${BRAND};text-decoration:none;font-weight:600;">${escapeHtml(tip.secondaryLabel)} →</a></p>`
    : ""
}
${signatureBlock()}`;

  const html = brandedEmailHtml({
    preheader: tip.tipBody.slice(0, 120),
    title: subject,
    bodyHtml,
    unsubUrl: unsub,
    kind: "tip",
  });

  return { subject, text, html, to: email, tip_id: tip.id, unsubUrl: unsub };
}

async function sendViaResend({
  to,
  subject,
  text,
  html,
  from = DEFAULT_FROM,
  unsubUrl,
  listUnsubscribeUrl,
  idempotencyKey,
}) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, provider: "resend", error: "RESEND_API_KEY not configured" };
  }

  const headers = {};
  const oneClickUrl = listUnsubscribeUrl || unsubUrl;
  if (oneClickUrl && String(oneClickUrl).includes("http")) {
    // One-click List-Unsubscribe (RFC 8058) — must POST to an API route, not a static page.
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

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      html,
      reply_to: REPLY_TO,
      headers,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      provider: "resend",
      error: body?.message || body?.error || `HTTP ${res.status}`,
    };
  }
  return { ok: true, provider: "resend", id: body?.id || null };
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
  const name = firstName || "there";
  const subject = firstName
    ? `${firstName}, congrats — you're a SuperCompress power user`
    : "Congrats — you're a SuperCompress power user";
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
    ? `You've crossed a million tokens. Congratulations — you're ${ordinal(rank)} all-time.`
    : "You've crossed a million tokens. Congratulations — you're officially a SuperCompress power user.";

  const statsLines = [];
  if (tin > 0) statsLines.push(`${fmt(tin)} tokens in`);
  if (saved > 0) statsLines.push(`${fmt(saved)} tokens saved${cut > 0 ? ` (~${cut}% cut)` : ""}`);
  if (reqs > 0) statsLines.push(`${fmt(reqs)} requests`);
  if (more > 0) statsLines.push(`~${more}% more usage from the same context budget`);
  const statsText = statsLines.length
    ? `\nWith SuperCompress: ${statsLines.join("; ")}.\n`
    : "\n";

  const text = `${hi},

You're a SuperCompress power user.

${leadText}
${statsText}
Pay-as-you-go is only $0.30 per million tokens. Load credits anytime: ${billingUrl}

— Arjun
Founder, SuperCompress
`;

  const statItems = [];
  if (tin > 0) statItems.push(`<li style="margin:0 0 6px;"><strong>${fmt(tin)}</strong> tokens in</li>`);
  if (saved > 0) {
    statItems.push(
      `<li style="margin:0 0 6px;"><strong>${fmt(saved)}</strong> tokens saved${cut > 0 ? ` (~${cut}% cut)` : ""}</li>`
    );
  }
  if (reqs > 0) statItems.push(`<li style="margin:0 0 6px;"><strong>${fmt(reqs)}</strong> requests</li>`);
  if (more > 0) {
    statItems.push(
      `<li style="margin:0 0 6px;">~<strong>${more}%</strong> more usage from the same context budget</li>`
    );
  }

  const bodyHtml = `
    ${eyebrow("Power user")}
    ${displayHeadline(`${hi} — you're a SuperCompress power user`)}
    <p style="margin:0 0 14px;">${escapeHtml(leadText)}</p>
    ${hasRank ? proofCallout(`All-time leaderboard: ${ordinal(rank)} overall.`) : ""}
    ${
      statItems.length
        ? `<p style="margin:0 0 12px;">Your stats with SuperCompress:</p>
    <ul style="margin:0 0 16px;padding-left:18px;color:${INK};">
      ${statItems.join("\n      ")}
    </ul>`
        : ""
    }
    <p style="margin:0 0 12px;">Pay-as-you-go is only <strong>$0.30 per million tokens</strong> — load credits anytime.</p>
    ${ctaButton("Load credits", billingUrl)}
    ${signatureBlock()}
  `;

  const html = brandedEmailHtml({
    preheader: `${name}, you crossed 1M tokens. Congrats — you're a SuperCompress power user.`,
    title: subject,
    bodyHtml,
    kind: "welcome",
  });

  return { subject, text, html, to: email };
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

function campaignKind(campaignId) {
  const id = String(campaignId || "");
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
  if (cid && shipFile?.byCampaign?.[cid]?.bullets?.length) {
    const entry = shipFile.byCampaign[cid];
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
  const versionLabel = digest.versions.length
    ? digest.versions.map((v) => v.version).join(", ")
    : "this week";
  const headline =
    digest.headline ||
    (digest.versions.length
      ? `What just got better in SuperCompress`
      : `What we shipped this week`);
  const intro =
    digest.intro ||
    `A few releases that make SuperCompress more reliable in real agent and API setups — not a changelog dump.`;
  const subject =
    digest.subject ||
    `Shipped: more reliable agents + fewer dead ends · SuperCompress ${versionLabel}`;

  const bullets = digest.bullets.length
    ? digest.bullets
    : [
        "Fresh releases landed on the coding agent plugin and platform — open the docs for details.",
      ];

  const bulletText = bullets.map((b) => `• ${b}`).join("\n");
  const text = `${hi},

${headline}

${intro}

${bulletText}

Versions: ${versionLabel}

Dashboard: ${SITE}/dashboard
Coding agents: ${SITE}/docs/coding-agents
Docs: ${SITE}/docs

— Arjun
Founder, SuperCompress

Unsubscribe: ${unsub}
`;

  const bodyHtml = `
<p style="margin:0 0 16px;font-size:16px;">${escapeHtml(hi)},</p>
${eyebrow(`Wednesday ship · ${versionLabel}`)}
${displayHeadline(headline)}
<p style="margin:0 0 18px;">${escapeHtml(intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
${shipBulletCards(bullets)}
</table>
${ctaButton("Open your dashboard →", `${SITE}/dashboard`)}
<p style="margin:14px 0 0;font-size:14px;">
  <a href="${SITE}/docs/coding-agents" style="color:${BRAND};text-decoration:none;font-weight:600;">Coding agents setup</a>
  · <a href="${SITE}/docs" style="color:${BRAND};text-decoration:none;font-weight:600;">Docs</a>
  · <a href="${SITE}/benchmarks" style="color:${BRAND};text-decoration:none;font-weight:600;">Benchmarks</a>
</p>
${signatureBlock()}`;

  return {
    subject,
    text,
    html: brandedEmailHtml({
      title: subject,
      preheader: intro.slice(0, 110),
      bodyHtml,
      unsubUrl: unsub,
      kind: "ship",
    }),
    to: email,
    tip_id: `ship-${campaignId || "week"}`,
    kind: "ship",
    unsubUrl: unsub,
    versions: digest.versions.map((v) => v.version),
  };
}

function weeklyEmailCopy(opts) {
  if (campaignKind(opts.campaignId) === "ship") {
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

module.exports = {
  welcomeCopy,
  powerUserCopy,
  weeklyCopy,
  shipCopy,
  weeklyEmailCopy,
  campaignKind,
  loadShipDigest,
  parseRecentChangelog,
  weeklyTipForCampaign,
  WEEKLY_TIPS,
  brandedEmailHtml,
  sendViaResend,
  sendWelcomeEmail,
  sendPowerUserEmail,
  sendWeeklyEmail,
  DEFAULT_FROM,
};
