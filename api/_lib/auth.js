/** Dashboard auth — Firebase ID tokens + optional local-only dev mode. */

const admin = require("firebase-admin");

let firebaseReady = false;

function bearerToken(authorization) {
  if (!authorization) return null;
  const parts = authorization.split(" ", 2);
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1].trim();
  return authorization.trim();
}

function parseServiceAccountJson(raw) {
  if (!raw || !String(raw).trim()) return null;
  const text = String(raw).trim();
  const candidates = [text];
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    candidates.push(text.slice(1, -1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
    } catch {}
    try {
      const repaired = candidate.replace(
        /("private_key"\s*:\s*")([\s\S]*?)("\s*,\s*"client_email")/,
        (_, prefix, key, suffix) => prefix + key.replace(/\r?\n/g, "\\n") + suffix
      );
      const parsed = JSON.parse(repaired);
      return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
    } catch {}
  }
  return null;
}

function isTruthyEnv(name) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function isProductionRuntime() {
  const vercelEnv = String(process.env.VERCEL_ENV || "").trim().toLowerCase();
  if (vercelEnv === "production") return true;
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

/** Trusted project id only — never from an unverified JWT. */
function expectedFirebaseProjectId() {
  const fromEnv = String(process.env.FIREBASE_PROJECT_ID || "").trim();
  if (fromEnv) return fromEnv;
  const cred = parseServiceAccountJson(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (cred?.project_id) return String(cred.project_id).trim();
  return "";
}

function initFirebaseAdmin() {
  if (firebaseReady) return true;
  if (admin.apps.length) {
    firebaseReady = true;
    return true;
  }

  try {
    const projectId = expectedFirebaseProjectId();
    const cred = parseServiceAccountJson(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (cred?.project_id && cred?.client_email && cred?.private_key) {
      admin.initializeApp({
        projectId: projectId || cred.project_id,
        credential: admin.credential.cert({
          ...cred,
          private_key: String(cred.private_key).replace(/\\n/g, "\n"),
        }),
      });
      firebaseReady = true;
      return true;
    }

    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (projectId && clientEmail && privateKey) {
      admin.initializeApp({
        projectId,
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, "\n"),
        }),
      });
      firebaseReady = true;
      return true;
    }

    // projectId-only init is insecure in multi-tenant hosts (wrong ADC / ambient creds).
    // Allow only with an explicit opt-in for local tooling that has trusted ADC.
    if (projectId && isTruthyEnv("SC_FIREBASE_ALLOW_PROJECT_ONLY")) {
      admin.initializeApp({ projectId });
      firebaseReady = true;
      return true;
    }
  } catch (err) {
    console.error("Firebase Admin init failed:", err.message);
  }

  return false;
}

function assertTokenProject(decoded) {
  const expected = expectedFirebaseProjectId();
  if (!expected) return;
  if (String(decoded.aud || "") !== expected) {
    const err = new Error("Invalid or expired Firebase token");
    err.status = 401;
    throw err;
  }
  const expectedIss = `https://securetoken.google.com/${expected}`;
  if (String(decoded.iss || "") !== expectedIss) {
    const err = new Error("Invalid or expired Firebase token");
    err.status = 401;
    throw err;
  }
}

async function verifyUser(req) {
  if (isProductionRuntime() && isTruthyEnv("SC_AUTH_DEV")) {
    const err = new Error("Auth misconfigured");
    err.status = 500;
    throw err;
  }

  const token = bearerToken(req.headers.authorization);
  if (!token) {
    const err = new Error("Missing Authorization header");
    err.status = 401;
    throw err;
  }

  if (token.startsWith("dev:")) {
    if (isTruthyEnv("SC_AUTH_DEV") && !isProductionRuntime()) {
      const parts = token.split(":");
      return {
        uid: parts[1] || "dev-user",
        email: parts[2] || "dev@local",
      };
    }
    const err = new Error("Invalid or expired Firebase token");
    err.status = 401;
    throw err;
  }

  if (initFirebaseAdmin()) {
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      assertTokenProject(decoded);
      return {
        uid: decoded.uid,
        email: decoded.email || null,
      };
    } catch (err) {
      if (err && err.status === 401) throw err;
      const e = new Error("Invalid or expired Firebase token");
      e.status = 401;
      throw e;
    }
  }

  const err = new Error(
    "Firebase auth not configured on this deployment — add FIREBASE_PROJECT_ID or FIREBASE_SERVICE_ACCOUNT_JSON to the supercompress Vercel project"
  );
  err.status = 401;
  throw err;
}

module.exports = {
  bearerToken,
  verifyUser,
  initFirebaseAdmin,
  expectedFirebaseProjectId,
  assertTokenProject,
  isProductionRuntime,
};
