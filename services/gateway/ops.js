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
 * Build insights from the process gateway ledger (in-memory / durable).
 */
function getOpsInsights(opts = {}) {
  const gw = getProcessGateway(opts.gatewayOptions || {});
  const records = typeof gw.ledger?.list === "function" ? gw.ledger.list({}) : [];
  return buildOpsInsights(records, {
    org_id: opts.org_id,
    budget_usd: opts.budget_usd,
  });
}

function getOpsOtel(opts = {}) {
  const gw = getProcessGateway(opts.gatewayOptions || {});
  const records = typeof gw.ledger?.list === "function" ? gw.ledger.list({}) : [];
  return buildOpsOtelExport(records, {
    org_id: opts.org_id,
    serviceName: opts.serviceName || "supercompress-control-plane",
  });
}

module.exports = {
  isOpsEnabled,
  getOpsInsights,
  getOpsOtel,
};
