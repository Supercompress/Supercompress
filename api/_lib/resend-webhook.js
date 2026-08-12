/**
 * Resend webhook helpers (Svix signature verify + inbound email.received).
 * Docs: https://resend.com/docs/webhooks/verify-webhooks-requests
 */
const crypto = require("crypto");
const { initFirebaseAdmin } = require("./auth");
const { sendViaResend } = require("./mail");

const MAX_SKEW_SEC = 300;
const BODY_PREVIEW_CHARS = 4000;

function header(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return String(v || "");
  }
  return "";
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify Resend/Svix webhook. Returns parsed JSON event.
 * @param {string|Buffer} rawBody
 * @param {Record<string, string>} headers
 * @param {string} secret whsec_…
 */
function verifyResendWebhook(rawBody, headers, secret) {
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  const whsec = String(secret || "").trim();
  if (!whsec) {
    const err = new Error("RESEND_WEBHOOK_SECRET not configured");
    err.status = 503;
    throw err;
  }

  const id = header(headers, "svix-id");
  const timestamp = header(headers, "svix-timestamp");
  const signatureHeader = header(headers, "svix-signature");
  if (!id || !timestamp || !signatureHeader) {
    const err = new Error("Missing Svix signature headers");
    err.status = 400;
    throw err;
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    const err = new Error("Invalid Svix timestamp");
    err.status = 400;
    throw err;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > MAX_SKEW_SEC) {
    const err = new Error("Svix timestamp outside allowed skew");
    err.status = 400;
    throw err;
  }

  const secretPart = whsec.startsWith("whsec_") ? whsec.slice("whsec_".length) : whsec;
  let key;
  try {
    key = Buffer.from(secretPart, "base64");
  } catch {
    const err = new Error("Invalid RESEND_WEBHOOK_SECRET");
    err.status = 503;
    throw err;
  }
  if (!key.length) {
    const err = new Error("Invalid RESEND_WEBHOOK_SECRET");
    err.status = 503;
    throw err;
  }

  const signed = `${id}.${timestamp}.${payload}`;
  const expected = crypto.createHmac("sha256", key).update(signed, "utf8").digest("base64");
  const ok = String(signatureHeader)
    .split(/\s+/)
    .some((part) => {
      const [ver, sig] = part.split(",");
      return ver === "v1" && sig && timingSafeEqualStr(sig, expected);
    });
  if (!ok) {
    const err = new Error("Invalid webhook signature");
    err.status = 400;
    throw err;
  }

  try {
    return JSON.parse(payload);
  } catch {
    const err = new Error("Invalid JSON payload");
    err.status = 400;
    throw err;
  }
}

function clip(s, n = BODY_PREVIEW_CHARS) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

async function fetchReceivedEmail(emailId) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey || !emailId) return null;
  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.warn("resend receiving get failed:", res.status, detail.slice(0, 200));
    return null;
  }
  return res.json();
}

function inboundNotifyTo() {
  return (
    (process.env.RESEND_INBOUND_NOTIFY_TO || "").trim() ||
    (process.env.WELCOME_REPLY_TO || "").trim() ||
    "arjunkshah21@gmail.com"
  );
}

function shouldNotify(fromAddr, subject) {
  const notify = inboundNotifyTo().toLowerCase();
  const from = String(fromAddr || "").toLowerCase();
  if (from && notify && from.includes(notify)) return false;
  if (/^\[sc inbound\]/i.test(String(subject || ""))) return false;
  return true;
}

async function persistInbound(record) {
  try {
    initFirebaseAdmin();
    const db = require("firebase-admin").firestore();
    const id = String(record.email_id || record.svix_id || `anon_${Date.now()}`);
    const ref = db.collection("inbound_mail").doc(id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        record._duplicate = true;
        return;
      }
      tx.set(ref, {
        ...record,
        created_at: new Date().toISOString(),
        // Soft retention hint for ops / TTL policies (not auto-deleted here).
        retain_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    });
    return record;
  } catch (err) {
    console.warn("inbound_mail persist failed:", err.message);
    return record;
  }
}

async function notifyInbound(meta, body) {
  if (!shouldNotify(meta.from, meta.subject)) {
    return { ok: true, skipped: true };
  }
  const to = inboundNotifyTo();
  const textBody = clip(body?.text || body?.html?.replace(/<[^>]+>/g, " ") || "(no body fetched)");
  const subject = `[SC inbound] ${clip(meta.subject || "(no subject)", 80)}`;
  const text = [
    `Inbound email via Resend`,
    `From: ${meta.from || "?"}`,
    `To: ${(meta.to || []).join(", ") || "?"}`,
    `Subject: ${meta.subject || "?"}`,
    `Email id: ${meta.email_id || "?"}`,
    ``,
    textBody,
  ].join("\n");
  return sendViaResend({
    to,
    subject,
    text,
    html: `<pre style="font:14px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Handle a verified Resend event. Returns a small JSON-serializable result.
 */
async function handleResendEvent(event, { svixId } = {}) {
  const type = event?.type || "";
  if (type !== "email.received") {
    return { ok: true, ignored: true, type };
  }

  const data = event.data || {};
  const emailId = data.email_id || "";
  const meta = {
    email_id: emailId,
    svix_id: svixId || "",
    from: data.from || "",
    to: Array.isArray(data.to) ? data.to : [],
    cc: Array.isArray(data.cc) ? data.cc : [],
    subject: data.subject || "",
    message_id: data.message_id || "",
    attachments: Array.isArray(data.attachments) ? data.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type,
    })) : [],
    created_at_provider: data.created_at || event.created_at || "",
  };

  const body = await fetchReceivedEmail(emailId);
  const record = {
    ...meta,
    text_preview: clip(body?.text || ""),
    html_preview: clip(body?.html || ""),
    fetched: Boolean(body),
  };

  await persistInbound(record);
  if (record._duplicate) {
    return { ok: true, duplicate: true, email_id: emailId };
  }

  const notify = await notifyInbound(meta, body);
  return {
    ok: true,
    email_id: emailId,
    fetched: record.fetched,
    notified: Boolean(notify?.ok) && !notify?.skipped,
    notify_skipped: Boolean(notify?.skipped),
    notify_error: notify?.ok ? null : notify?.error || null,
  };
}

module.exports = {
  verifyResendWebhook,
  handleResendEvent,
  fetchReceivedEmail,
  inboundNotifyTo,
  shouldNotify,
  // test helpers
  _timingSafeEqualStr: timingSafeEqualStr,
  BODY_PREVIEW_CHARS,
  MAX_SKEW_SEC,
};
