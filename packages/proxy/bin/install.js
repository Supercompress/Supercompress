#!/usr/bin/env node

/**
 * postinstall — guidance only.
 * Do NOT mutate agent MCP configs here (npm install can run in CI / as a
 * transitive dep). Users opt in via `supercompress setup` or `supercompress plugin`.
 */

const pkg = require("../package.json");

console.log(`SuperCompress v${pkg.version} installed.`);
console.log("Next: run `supercompress setup` — links your account and auto-adds MCP + hooks");
console.log("     for every detected coding agent (npm install alone does not).");
console.log("Or:   `supercompress plugin` to re-detect and refresh integrations anytime.");
console.log("Docs: https://docs.supercompress.dev/coding-agents");
