"use strict";

/**
 * Unadvertised ops surface — insights + OTel export.
 * Enable only when SC_CP_OPS=1.
 */

const {
  flags,
  buildOpsInsights,
  buildOpsOtelExport,
} = require("../../packages/control-plane");
const { getProcessGateway } = require("./http");

function isOpsEnabled() {
  return flags().ops;
}

/**
 * Resolve insights vs otel after Vercel rewrite collapse.
 * Prefer ?export=otel; also accept /otel path suffixes and x-matched-path.
 */
function resolveOpsSurface(urlOrPath = "/", headers = {}) {
  const raw = String(urlOrPath || "/");
  let exportParam = "";
  let pathname = raw;
  try {
    const u = new URL(raw, "http://localhost");
    exportParam = String(u.searchParams.get("export") || "").toLowerCase();
    pathname = u.pathname;
  } catch {
    const q = raw.indexOf("?");
    if (q >= 0) {
      pathname = raw.slice(0, q);
      const params = new URLSearchParams(raw.slice(q + 1));
      exportParam = String(params.get("export") || "").toLowerCase();
    }
  }
  const matched = String(
    headers["x-matched-path"] || headers["x-vercel-matched-path"] || ""
  ).toLowerCase();
  const hay = `${pathname} ${matched}`.toLowerCase();
  if (exportParam === "otel" || hay.includes("/otel")) return "otel";
  return "insights";
}

function ledgerRecords(opts = {}) {
  if (opts.ledger && typeof opts.ledger.list === "function") {
    return opts.ledger.list({});
  }
  if (Array.isArray(opts.records)) return opts.records;
  const gw = getProcessGateway(opts.gatewayOptions || {});
  return typeof gw.ledger?.list === "function" ? gw.ledger.list({}) : [];
}

/**
 * Build insights from ledger (injectable) or process gateway singleton.
 */
function getOpsInsights(opts = {}) {
  const records = ledgerRecords(opts);
  return buildOpsInsights(records, {
    org_id: opts.org_id,
    budget_usd: opts.budget_usd,
  });
}

function getOpsOtel(opts = {}) {
  const records = ledgerRecords(opts);
  return buildOpsOtelExport(records, {
    org_id: opts.org_id,
    serviceName: opts.serviceName || "supercompress-control-plane",
  });
}

module.exports = {
  isOpsEnabled,
  resolveOpsSurface,
  getOpsInsights,
  getOpsOtel,
};
