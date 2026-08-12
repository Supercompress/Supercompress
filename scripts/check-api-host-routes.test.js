/**
 * Regression: api-host catch-all detector must treat any :param(.*) as dangerous.
 * Run: node scripts/check-api-host-routes.test.js
 */
const assert = require("assert");
const { isCatchAllOrRegex } = require("./check-api-host-routes");

assert.strictEqual(isCatchAllOrRegex("/:path(.*)"), true);
assert.strictEqual(isCatchAllOrRegex("/:splat(.*)"), true);
assert.strictEqual(isCatchAllOrRegex("/:rest(.*)"), true);
assert.strictEqual(isCatchAllOrRegex("/:splat*"), true);
assert.strictEqual(isCatchAllOrRegex("/*"), true);
assert.strictEqual(isCatchAllOrRegex("/api/v1/compress"), false);
assert.strictEqual(isCatchAllOrRegex("/dashboard"), false);

console.log("check-api-host-routes tests ok");
