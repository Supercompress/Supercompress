const { skipFirestore } = require("./firebase-off");
const { gistConfigured } = require("./gist-store");

function getPersistenceConfig() {
  const env = process.env;
  const production =
    env.VERCEL_ENV === "production" ||
    env.NODE_ENV === "production" ||
    String(env.SC_FORCE_PROD || "").trim() === "1" ||
    Boolean(String(env.FLY_APP_NAME || "").trim()) ||
    Boolean(String(env.FLY_MACHINE_ID || "").trim());
  const firestoreEnabled = !skipFirestore();
  const gistDisabled = String(env.SUPERCOMPRESS_DISABLE_GIST || "").trim() === "1";
  const gistOptIn = String(env.SUPERCOMPRESS_ALLOW_GIST || "").trim() === "1";
  const gistAvailable = gistConfigured();
  const gistAllowed = !gistDisabled && (!production || gistOptIn) && gistAvailable;
  return {
    production,
    firestoreEnabled,
    gistConfigured: gistAvailable,
    gistAllowed,
    gistBreakGlass: production && gistAllowed,
    backend: firestoreEnabled ? "firestore" : gistAllowed ? "gist" : "claims",
  };
}

function getPersistenceReadiness({ firestoreUnavailable = false, lastSuccessfulBackend = null } = {}) {
  const config = getPersistenceConfig();
  const storeBackend = config.firestoreEnabled && !firestoreUnavailable
    ? "firestore"
    : config.gistAllowed ? "gist" : "memory";
  return {
    ...config,
    storeBackend,
    keyAndBillingBackend: config.firestoreEnabled ? "firestore-with-claims-fallback" : "claims",
    firestoreState: !config.firestoreEnabled ? "disabled"
      : firestoreUnavailable ? "unavailable"
        : lastSuccessfulBackend === "firestore" ? "observed" : "not-probed",
    lastSuccessfulBackend: ["firestore", "gist", "memory"].includes(lastSuccessfulBackend)
      ? lastSuccessfulBackend : null,
    readiness: storeBackend === "memory" ? "process-local-only" : "unverified",
    connectivityVerified: false,
    retirement: {
      status: "blocked",
      reason: "billing-history-reconciliation-required",
      reconciliationVerified: false,
    },
  };
}

module.exports = { getPersistenceConfig, getPersistenceReadiness };
