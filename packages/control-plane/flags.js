"use strict";

/**
 * Feature flags for control-plane primitives.
 * Default OFF — production stays unchanged until explicitly enabled.
 */
function flagOn(name) {
  const v = String(process.env[name] || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function flags() {
  return {
    ledger: flagOn("SC_CP_LEDGER"),
    trace: flagOn("SC_CP_TRACE"),
    reserve: flagOn("SC_CP_RESERVE"),
    gateway: flagOn("SC_CP_GATEWAY"),
    route: flagOn("SC_CP_ROUTE"),
    enterprise: flagOn("SC_CP_ENTERPRISE"),
  };
}

module.exports = { flagOn, flags };
