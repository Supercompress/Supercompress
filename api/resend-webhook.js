/**
 * POST /api/resend/webhook  (rewrite → /api/resend-webhook)
 *
 * Resend inbound + delivery webhooks (Svix-signed).
 * Register in Resend dashboard:
 *   URL:    https://www.supercompress.dev/api/resend/webhook
 *   Events: email.received  (add others if you want delivery telemetry)
 *   Secret: RESEND_WEBHOOK_SECRET=whsec_… on Vercel
 *
 * email.received → fetch body via Receiving API → inbound_mail/{id} → notify RESEND_INBOUND_NOTIFY_TO
 */
const {
  verifyResendWebhook,
  handleResendEvent,
} = require("./_lib/resend-webhook");

module.exports.config = { api: { bodyParser: false } };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, svix-id, svix-timestamp, svix-signature"
  );
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    corsHeaders(res);
    return res.status(405).json({ detail: "Method not allowed" });
  }

  const webhookSecret = (process.env.RESEND_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) {
    corsHeaders(res);
    return res.status(503).json({ detail: "RESEND_WEBHOOK_SECRET not configured" });
  }

  try {
    const rawBody = await readRawBody(req);
    const event = verifyResendWebhook(rawBody, req.headers, webhookSecret);
    const svixId = req.headers["svix-id"] || req.headers["Svix-Id"] || "";
    const result = await handleResendEvent(event, { svixId: String(svixId) });
    corsHeaders(res);
    return res.status(200).json(result);
  } catch (err) {
    const status = err.status || 400;
    console.error("resend webhook error:", err.message);
    corsHeaders(res);
    return res.status(status).json({ detail: err.message || "Webhook error" });
  }
};
