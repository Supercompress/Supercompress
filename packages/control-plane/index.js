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
const { createStoreFromEnv } = require("./store-from-env");
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
  createStoreFromEnv,
  withDirLock,
  summarizeRequests,
  evaluateAlerts,
  summarizeEvalComparison,
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
