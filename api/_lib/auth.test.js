/**
 * Auth unit tests — trusted Firebase project identity + prod fail-closed for SC_AUTH_DEV.
 * Run: node --test api/_lib/auth.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

describe("auth trusted project identity", () => {
  const prev = {};

  beforeEach(() => {
    for (const k of [
      "FIREBASE_PROJECT_ID",
      "FIREBASE_SERVICE_ACCOUNT_JSON",
      "SC_AUTH_DEV",
      "VERCEL_ENV",
      "NODE_ENV",
    ]) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    // Fresh module each time so firebaseReady / apps state isn't sticky across env flips.
    delete require.cache[require.resolve("./auth")];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[require.resolve("./auth")];
  });

  it("expectedFirebaseProjectId comes from env, not token", () => {
    process.env.FIREBASE_PROJECT_ID = "trusted-project";
    const { expectedFirebaseProjectId } = require("./auth");
    assert.equal(expectedFirebaseProjectId(), "trusted-project");
  });

  it("assertTokenProject rejects mismatched aud", () => {
    process.env.FIREBASE_PROJECT_ID = "trusted-project";
    const { assertTokenProject } = require("./auth");
    assert.throws(
      () =>
        assertTokenProject({
          aud: "other-project",
          iss: "https://securetoken.google.com/other-project",
        }),
      (err) => err && err.status === 401
    );
  });

  it("assertTokenProject accepts matching aud/iss", () => {
    process.env.FIREBASE_PROJECT_ID = "trusted-project";
    const { assertTokenProject } = require("./auth");
    assert.doesNotThrow(() =>
      assertTokenProject({
        aud: "trusted-project",
        iss: "https://securetoken.google.com/trusted-project",
      })
    );
  });

  it("production + SC_AUTH_DEV fails closed", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.SC_AUTH_DEV = "true";
    const { verifyUser } = require("./auth");
    await assert.rejects(
      () => verifyUser({ headers: { authorization: "Bearer anything" } }),
      (err) => err && err.status === 500
    );
  });

  it("dev tokens are rejected when SC_AUTH_DEV is off", async () => {
    process.env.NODE_ENV = "development";
    process.env.SC_AUTH_DEV = "0";
    const { verifyUser } = require("./auth");
    await assert.rejects(
      () => verifyUser({ headers: { authorization: "Bearer dev:u:dev@local" } }),
      (err) => err && err.status === 401
    );
  });
});
