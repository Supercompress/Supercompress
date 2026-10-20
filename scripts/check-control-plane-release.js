"use strict";

const fs = require("node:fs");
const path = require("node:path");

const flagNames = ["LEDGER", "TRACE", "RESERVE", "GATEWAY", "ROUTE", "ENTERPRISE", "OPS"].map((name) => `SC_CP_${name}`);

function checkRelease(env, config) {
  for (const name of flagNames) {
    const value = String(env[name] || "").trim().toLowerCase();
    if (value && !["0", "false", "no", "off"].includes(value)) {
      throw new Error(`${name} must remain off: control plane is not approved for launch.`);
    }
    if (!new RegExp(`^\\s*${name} = "0"\\s*$`, "m").test(config)) {
      throw new Error(`fly.api.toml must explicitly disable ${name}.`);
    }
  }
}

function checkSecrets(secrets) {
  if (!Array.isArray(secrets)) throw new Error("Expected Fly secrets inventory array.");
  for (const secret of secrets) {
    const name = secret && (secret.Name || secret.name);
    if (typeof name !== "string" || !name) throw new Error("Invalid Fly secrets inventory entry.");
    if (flagNames.includes(name)) {
      throw new Error(`${name} exists as a Fly secret and can override disabled config. Remove the flag secret before deploying.`);
    }
  }
}

if (require.main === module) {
  try {
    if (process.argv.includes("--fly-secrets")) checkSecrets(JSON.parse(fs.readFileSync(0, "utf8")));
    else checkRelease(process.env, fs.readFileSync(path.join(__dirname, "../fly.api.toml"), "utf8"));
    console.log("Control-plane release guard passed (unreleased flags remain off).");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { flagNames, checkRelease, checkSecrets };
