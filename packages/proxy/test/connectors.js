#!/usr/bin/env node
const assert = require("assert");
const { allConnectors, findConnector, slugify } = require("../src/connectors");

const all = allConnectors();
assert.ok(all.length >= 30, "expected many connectors");
assert.ok(findConnector("cursor"), "cursor connector");
assert.ok(findConnector("claude-code"), "claude-code connector");
assert.ok(findConnector("vercel-ai-sdk"), "vercel-ai-sdk connector");
assert.equal(slugify("Claude Code"), "claude-code");
const cursor = findConnector("cursor");
assert.ok(cursor.auto, "cursor should be auto MCP");
assert.ok(cursor.install.length >= 2);
console.log("connectors ok", all.length);
