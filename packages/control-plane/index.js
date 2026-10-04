"use strict";

const { flagOn, flags } = require("./flags");
const { createLedgerStore, LIFECYCLE, FAIL_STATUSES } = require("./ledger");
const {
  buildCompressionTrace,
  estimateDollarsAvoided,
  inferStrategyFromResult,
  traceFromCompressResult,
} = require("./compression-trace");
const { normalizePolicy, evaluateAdmission } = require("./policy");
const { createReservationStore } = require("./reservation");
const { summarizeRequests, evaluateAlerts, summarizeEvalComparison } = require("./obs");
const {
  selectRoute,
  nextFallback,
  isRetryableProviderError,
  evaluateEligibility,
  estimateRequestUsd,
  normalizeRouting,
  normalizeCatalog,
  defaultCatalog,
} = require("./router");
const { DEFAULT_CATALOG } = require("./catalog");
const { createMemoryDurableStore, assertDurableStore } = require("./durable-store");
const {
  createDurableLedgerStore,
  createDurableReservationStore,
  assertLedgerStore,
  assertReservationStore,
} = require("./durable");
const { createPostgresDurableStore, SCHEMA_SQL } = require("./pg-store");
const { createPostgresLedgerStore, LEDGER_SCHEMA_SQL } = require("./pg-ledger");
const { createStoreFromEnv } = require("./store-from-env");
const { computeRouteEconomics, attachEconomicsToTrace } = require("./economics");
const { recordToOtelSpan, exportOtelBundle } = require("./otel");
const { buildOpsInsights, buildOpsOtelExport } = require("./insights");
const { createRateLimitStore, rateLimitKey } = require("./rate-limit");
const { createHealthTracker } = require("./health-tracker");
const { sumDaySpendUsd, startOfUtcDay } = require("./spend");
const { withDirLock } = require("./file-lock");

module.exports = {
  flagOn,
  flags,
  createLedgerStore,
  LIFECYCLE,
  FAIL_STATUSES,
  buildCompressionTrace,
  estimateDollarsAvoided,
  inferStrategyFromResult,
  traceFromCompressResult,
  normalizePolicy,
  evaluateAdmission,
  createReservationStore,
  createMemoryDurableStore,
  assertDurableStore,
  createDurableLedgerStore,
  createDurableReservationStore,
  assertLedgerStore,
  assertReservationStore,
  createPostgresDurableStore,
  SCHEMA_SQL,
  createPostgresLedgerStore,
  LEDGER_SCHEMA_SQL,
  createStoreFromEnv,
  withDirLock,
  summarizeRequests,
  evaluateAlerts,
  summarizeEvalComparison,
  computeRouteEconomics,
  attachEconomicsToTrace,
  recordToOtelSpan,
  exportOtelBundle,
  buildOpsInsights,
  buildOpsOtelExport,
  createRateLimitStore,
  rateLimitKey,
  createHealthTracker,
  sumDaySpendUsd,
  startOfUtcDay,
  selectRoute,
  nextFallback,
  isRetryableProviderError,
  evaluateEligibility,
  estimateRequestUsd,
  normalizeRouting,
  normalizeCatalog,
  defaultCatalog,
  DEFAULT_CATALOG,
};
