"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const manifest = require("../package.json");
const lockfile = require("../package-lock.json");

test("Firestore is a required production dependency", () => {
  const dependency = manifest.dependencies["@google-cloud/firestore"];
  assert.ok(dependency, "production installs omit Firebase Admin's optional Firestore dependency");
  assert.equal(lockfile.packages[""].dependencies["@google-cloud/firestore"], dependency);
  assert.notEqual(lockfile.packages["node_modules/@google-cloud/firestore"].optional, true);
});

test("Firebase Admin can load the Firestore namespace without credentials", () => {
  const admin = require("firebase-admin");
  assert.equal(typeof admin.firestore, "function");
  assert.equal(typeof admin.firestore.FieldValue.serverTimestamp, "function");
  assert.ok(admin.firestore.FieldValue.serverTimestamp());
});

test("MCP, OAuth and compression entrypoints load with production dependencies", () => {
  for (const entrypoint of ["../api/_lib/rate-limit-durable", "../api/v1/compress", "../api/oauth", "../api/mcp"]) {
    assert.doesNotThrow(() => require(entrypoint), `${entrypoint} must load without optional packages`);
  }
});
