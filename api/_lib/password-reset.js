/**
 * Branded password-reset via Firebase Admin link + Resend.
 * Public endpoint — always returns a generic success payload (no account enumeration).
 * Google-only (and other non-password) accounts never receive a reset email.
 */

const { initFirebaseAdmin } = require("./auth");

const SITE = "https://www.supercompress.dev";
const CONTINUE_URL = `${SITE}/dashboard?login=1&reset=1`;

function normalizeEmail(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .slice(0, 254);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** True if Firebase Auth user has email/password linked. */
function userHasPasswordProvider(userRecord) {
  const providers = Array.isArray(userRecord?.providerData)
    ? userRecord.providerData
    : [];
  return providers.some((p) => p?.providerId === "password");
}

async function getAuthUserByEmail(email) {
  const admin = require("firebase-admin");
  if (!initFirebaseAdmin()) {
    const err = new Error("Auth is not configured");
    err.status = 503;
    throw err;
  }
  return admin.auth().getUserByEmail(email);
}

async function generateResetLink(email) {
  const admin = require("firebase-admin");
  if (!initFirebaseAdmin()) {
    const err = new Error("Auth is not configured");
    err.status = 503;
    throw err;
  }
  return admin.auth().generatePasswordResetLink(email, {
    url: CONTINUE_URL,
    handleCodeInApp: false,
  });
}

/**
 * @returns {{ ok: true, sent?: boolean, detail: string }}
 */
async function requestPasswordReset(emailRaw, { intent = "reset" } = {}) {
  const email = normalizeEmail(emailRaw);
  const isChange = String(intent || "").toLowerCase() === "change";
  const generic = {
    ok: true,
    detail: isChange
      ? "If that account uses email/password, we sent a password change link. Check inbox and spam."
      : "If an account exists for that email with a password, we sent a reset link. Check inbox and spam. Google sign-in accounts use Google — not email reset.",
  };
  if (!isValidEmail(email)) {
    const err = new Error("Enter a valid email address.");
    err.status = 400;
    throw err;
  }

  let user;
  try {
    user = await getAuthUserByEmail(email);
  } catch (err) {
    const code = String(err?.code || err?.errorInfo?.code || "");
    if (
      code.includes("user-not-found") ||
      code.includes("invalid-email") ||
      code.includes("user-disabled")
    ) {
      return generic;
    }
    console.warn("password-reset lookup failed:", code || err.message || err);
    const fail = new Error("Could not start password reset. Try again in a minute.");
    fail.status = 503;
    throw fail;
  }

  // Google-only / OAuth-only — no password to reset; do not send mail.
  if (!userHasPasswordProvider(user)) {
    return generic;
  }

  let link;
  try {
    link = await generateResetLink(email);
  } catch (err) {
    const code = String(err?.code || err?.errorInfo?.code || "");
    if (
      code.includes("user-not-found") ||
      code.includes("invalid-email") ||
      code.includes("user-disabled")
    ) {
      return generic;
    }
    console.warn("password-reset link failed:", code || err.message || err);
    const fail = new Error("Could not start password reset. Try again in a minute.");
    fail.status = 503;
    throw fail;
  }

  const { sendPasswordResetEmail } = require("./mail");
  const result = await sendPasswordResetEmail({
    email,
    resetUrl: link,
    intent: isChange ? "change" : "reset",
    idempotencyKey: `pwd-${isChange ? "change" : "reset"}:${email}:${new Date().toISOString().slice(0, 13)}`,
  });
  if (!result.ok) {
    console.warn("password-reset Resend failed:", result.error || result);
    const fail = new Error("Could not send reset email. Try again in a minute.");
    fail.status = 503;
    throw fail;
  }
  return { ...generic, sent: true };
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  userHasPasswordProvider,
  getAuthUserByEmail,
  generateResetLink,
  requestPasswordReset,
  CONTINUE_URL,
  SITE,
};
