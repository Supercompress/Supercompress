"use strict";

/**
 * Control-plane release guard.
 *
 *   node scripts/check-control-plane-release.js            supercompress-api: every SC_CP_* flag off
 *   node scripts/check-control-plane-release.js --gateway  supercompress-gateway: approved flags only,
 *                                                          with their dependencies satisfied
 *   ... --fly-secrets [--gateway] < secrets.json           no flag may be a Fly secret (secrets override config)
 *
 * Both modes also check that www (vercel.json) cannot run control-plane code: no Vercel
 * functions, and every CP path proxies to Fly.
 */

const fs = require("node:fs");
const path = require("node:path");

const flagNames = ["LEDGER", "TRACE", "RESERVE", "GATEWAY", "ROUTE", "ENTERPRISE", "OPS"].map((name) => `SC_CP_${name}`);

/** Flags approved for the gateway app at launch. Everything else must be "0". */
const GATEWAY_APPROVED = new Set(["SC_CP_GATEWAY", "SC_CP_LEDGER", "SC_CP_TRACE", "SC_CP_ROUTE"]);

/** flag → flags it needs on (and why). */
const DEPENDENCIES = {
  SC_CP_ROUTE: ["SC_CP_GATEWAY"],
  SC_CP_TRACE: ["SC_CP_GATEWAY"],
  SC_CP_LEDGER: ["SC_CP_GATEWAY"],
  // Ops reads the ledger; without it every insight is empty.
  SC_CP_OPS: ["SC_CP_LEDGER"],
  SC_CP_RESERVE: ["SC_CP_GATEWAY"],
};

/** Env that must never be set in a production config. */
const FORBIDDEN_ENV = ["SC_CP_ALLOW_STUB", "SC_AUTH_DEV", "SC_CP_WALLET_SEED"];

const OFF = new Set(["", "0", "false", "no", "off"]);

function tomlEnv(config) {
  const env = {};
  const block = /\[env\]([\s\S]*?)(?:\n\[|$)/.exec(config);
  if (!block) return env;
  for (const line of block[1].split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function isOn(v) {
  return !OFF.has(String(v ?? "").trim().toLowerCase());
}

function checkForbidden(env, config) {
  const cfg = tomlEnv(config);
  for (const name of FORBIDDEN_ENV) {
    if (cfg[name] !== undefined || (env[name] !== undefined && isOn(env[name]))) {
      throw new Error(`${name} must not be set in production.`);
    }
  }
}

function checkRelease(env, config) {
  for (const name of flagNames) {
    const value = String(env[name] || "").trim().toLowerCase();
    if (value && !OFF.has(value)) {
      throw new Error(`${name} must remain off on supercompress-api: the control plane runs on supercompress-gateway.`);
    }
    if (!new RegExp(`^\\s*${name} = "0"\\s*$`, "m").test(config)) {
      throw new Error(`fly.api.toml must explicitly disable ${name}.`);
    }
  }
  checkForbidden(env, config);
}

function checkGatewayRelease(env, config) {
  const cfg = tomlEnv(config);
  if (cfg.SC_API_SURFACE !== "gateway") {
    throw new Error('fly.gateway.toml must set SC_API_SURFACE = "gateway".');
  }
  if (cfg.NODE_ENV !== "production") throw new Error('fly.gateway.toml must set NODE_ENV = "production".');
  if (cfg.SUPERCOMPRESS_USE_FIRESTORE !== "0") {
    throw new Error('fly.gateway.toml must set SUPERCOMPRESS_USE_FIRESTORE = "0" (gateway billing runs on claims).');
  }
  const effective = {};
  for (const name of flagNames) {
    if (!(name in cfg)) throw new Error(`fly.gateway.toml must set ${name} explicitly.`);
    const value = env[name] !== undefined ? env[name] : cfg[name];
    effective[name] = isOn(value);
    if (effective[name] && !GATEWAY_APPROVED.has(name)) {
      throw new Error(`${name} is not approved for launch on supercompress-gateway.`);
    }
  }
  if (!effective.SC_CP_GATEWAY) throw new Error("SC_CP_GATEWAY must be on in fly.gateway.toml.");
  for (const [flag, needs] of Object.entries(DEPENDENCIES)) {
    if (!effective[flag]) continue;
    for (const dep of needs) {
      if (!effective[dep]) throw new Error(`${flag} requires ${dep}.`);
    }
  }
  checkForbidden(env, config);
}

/**
 * www must stay static: Vercel functions would run CP code with Vercel's env, a second
 * launch switch with no guard. Every CP path must proxy to Fly.
 */
function checkVercel(vercelJson) {
  const cfg = typeof vercelJson === "string" ? JSON.parse(vercelJson) : vercelJson;
  if (cfg.functions && Object.keys(cfg.functions).length) {
    throw new Error("vercel.json must not define functions: www is static and every API path proxies to Fly.");
  }
  const rewrites = cfg.rewrites || [];
  const cpSources = ["/v1/chat/completions", "/api/v1/chat/completions", "/v1/ops/insights", "/v1/ops/otel"];
  for (const src of cpSources) {
    const r = rewrites.find((x) => x.source === src);
    if (r && !/^https:\/\/supercompress-(api|gateway)\.fly\.dev\//.test(r.destination || "")) {
      throw new Error(`vercel.json ${src} must proxy to Fly, not run on Vercel.`);
    }
  }
  for (const r of rewrites) {
    if (/^\/api\//.test(r.destination || "")) {
      throw new Error(`vercel.json rewrite ${r.source} -> ${r.destination} targets a Vercel function.`);
    }
  }
}

function checkSecrets(secrets, opts = {}) {
  if (!Array.isArray(secrets)) throw new Error("Expected Fly secrets inventory array.");
  for (const secret of secrets) {
    const name = secret && (secret.Name || secret.name);
    if (typeof name !== "string" || !name) throw new Error("Invalid Fly secrets inventory entry.");
    if (flagNames.includes(name)) {
      throw new Error(`${name} exists as a Fly secret and can override disabled config. Remove the flag secret before deploying.`);
    }
    // The gateway's claims billing depends on SUPERCOMPRESS_USE_FIRESTORE=0 from config.
    if (FORBIDDEN_ENV.includes(name) || (opts.gateway && name === "SUPERCOMPRESS_USE_FIRESTORE")) {
      throw new Error(`${name} exists as a Fly secret and overrides fly config. Remove it before deploying.`);
    }
  }
}

if (require.main === module) {
  try {
    const gateway = process.argv.includes("--gateway");
    if (process.argv.includes("--fly-secrets")) {
      checkSecrets(JSON.parse(fs.readFileSync(0, "utf8")), { gateway });
    } else {
      const toml = gateway ? "../fly.gateway.toml" : "../fly.api.toml";
      const config = fs.readFileSync(path.join(__dirname, toml), "utf8");
      if (gateway) checkGatewayRelease(process.env, config);
      else checkRelease(process.env, config);
      checkVercel(fs.readFileSync(path.join(__dirname, "../vercel.json"), "utf8"));
    }
    console.log(
      gateway
        ? "Control-plane release guard passed (gateway flags approved, dependencies met)."
        : "Control-plane release guard passed (API flags off, www static)."
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  flagNames,
  GATEWAY_APPROVED,
  DEPENDENCIES,
  FORBIDDEN_ENV,
  tomlEnv,
  checkRelease,
  checkGatewayRelease,
  checkVercel,
  checkSecrets,
};
