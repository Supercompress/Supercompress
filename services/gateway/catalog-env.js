"use strict";

/**
 * The gateway's default routing catalog for this environment:
 *   1. DEFAULT_CATALOG (OpenAI + Anthropic) and PROVIDER_CATALOG entries whose provider is
 *      configured (its API key is set), so routing never picks a model it cannot call;
 *      with no provider configured at all (local dev, tests) the full DEFAULT_CATALOG is kept;
 *   2. the stub model is never included; tests pass it explicitly;
 *   3. operator entries from SC_CP_CATALOG (JSON array or { models: [...] }) or
 *      SC_CP_CATALOG_FILE (path to the same JSON). Operator entries replace defaults by id.
 */

const fs = require("node:fs");
const { DEFAULT_CATALOG, PROVIDER_CATALOG } = require("../../packages/control-plane/catalog");
const { isConfigured } = require("./providers/registry");

function parseOperatorCatalog(env) {
  let raw = env.SC_CP_CATALOG && String(env.SC_CP_CATALOG).trim();
  if (!raw && env.SC_CP_CATALOG_FILE) raw = fs.readFileSync(String(env.SC_CP_CATALOG_FILE), "utf8");
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`catalog_invalid_json: ${e.message}`);
    err.code = "catalog_invalid_json";
    throw err;
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.models || parsed?.catalog || [];
  if (!Array.isArray(list)) return [];
  return list;
}

function catalogFromEnv(env = process.env) {
  const byId = new Map();
  const anyConfigured = [...DEFAULT_CATALOG, ...PROVIDER_CATALOG].some((m) => isConfigured(m.provider, env));
  for (const m of DEFAULT_CATALOG) if (!anyConfigured || isConfigured(m.provider, env)) byId.set(m.id, m);
  for (const m of PROVIDER_CATALOG) if (isConfigured(m.provider, env)) byId.set(m.id, m);
  for (const m of parseOperatorCatalog(env)) if (m && m.id) byId.set(String(m.id), m);
  return [...byId.values()];
}

/**
 * Gateway-wide policy from SC_CP_POLICY (JSON object) or SC_CP_POLICY_FILE (path).
 * Same shape as normalizePolicy(): allow_models, deny_models, max_usd_per_request,
 * max_usd_per_day, rpm, tpm, compress_default, routing { strategy, prefer, fallbacks, … }.
 * Returns null when neither is set, so callers keep their own default.
 */
function policyFromEnv(env = process.env) {
  let raw = env.SC_CP_POLICY && String(env.SC_CP_POLICY).trim();
  if (!raw && env.SC_CP_POLICY_FILE) raw = fs.readFileSync(String(env.SC_CP_POLICY_FILE), "utf8");
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`policy_invalid_json: ${e.message}`);
    err.code = "policy_invalid_json";
    throw err;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const err = new Error("policy_invalid_json: expected an object");
    err.code = "policy_invalid_json";
    throw err;
  }
  return parsed;
}

module.exports = { catalogFromEnv, parseOperatorCatalog, policyFromEnv };
