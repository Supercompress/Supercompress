"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { flagNames, checkRelease, checkSecrets } = require("./check-control-plane-release");
const config = fs.readFileSync(path.join(__dirname, "../fly.api.toml"), "utf8");

test("production config explicitly disables every unreleased feature", () => {
  checkRelease({}, config);
  for (const name of flagNames) {
    for (const value of ["1", "true", "yes", "on", "typo"]) {
      assert.throws(() => checkRelease({ [name]: value }, config), /must remain off/);
    }
    for (const value of ["0", "false", "no", "off"]) checkRelease({ [name]: value }, config);
    assert.throws(() => checkRelease({}, config.replace(`${name} = "0"`, `${name} = "1"`)), /explicitly disable/);
  }
});

test("Fly secrets cannot override the release gate", () => {
  checkSecrets([{ Name: "STRIPE_SECRET_KEY" }]);
  for (const name of flagNames) {
    assert.throws(() => checkSecrets([{ Name: name }]), /override disabled config/);
    assert.throws(() => checkSecrets([{ name }]), /override disabled config/);
  }
  assert.throws(() => checkSecrets({}), /inventory array/);
  assert.throws(() => checkSecrets([{}]), /inventory entry/);
  assert.throws(() => checkSecrets([null]), /inventory entry/);
});

{
  const {
    checkGatewayRelease,
    checkVercel,
    checkSecrets: secrets,
  } = require("./check-control-plane-release");
  const gatewayToml = fs.readFileSync(path.join(__dirname, "../fly.gateway.toml"), "utf8");

  test("gateway guard: accepts the committed gateway config and rejects unapproved flags", () => {
    checkGatewayRelease({}, gatewayToml);
    assert.throws(() => checkGatewayRelease({ SC_CP_ENTERPRISE: "1" }, gatewayToml), /not approved/);
    assert.throws(
      () => checkGatewayRelease({}, gatewayToml.replace('SC_CP_GATEWAY = "1"', 'SC_CP_GATEWAY = "0"')),
      /requires SC_CP_GATEWAY|must be on/
    );
    assert.throws(
      () => checkGatewayRelease({}, gatewayToml.replace('SC_API_SURFACE = "gateway"', 'SC_API_SURFACE = "api"')),
      /SC_API_SURFACE/
    );
    assert.throws(() => checkGatewayRelease({}, `${gatewayToml.replace("[env]", '[env]\n  SC_CP_ALLOW_STUB = "1"')}`), /SC_CP_ALLOW_STUB/);
  });

  test("gateway guard: www may not run control-plane code on Vercel", () => {
    checkVercel(fs.readFileSync(path.join(__dirname, "../vercel.json"), "utf8"));
    assert.throws(() => checkVercel({ functions: { "api/v1/chat-completions.js": {} } }), /functions/);
    assert.throws(
      () => checkVercel({ rewrites: [{ source: "/v1/chat/completions", destination: "/api/v1/chat-completions" }] }),
      /Fly|Vercel function/
    );
  });

  test("gateway guard: gateway secrets cannot override the Firestore switch", () => {
    secrets([{ Name: "SUPERCOMPRESS_USE_FIRESTORE" }]);
    assert.throws(() => secrets([{ Name: "SUPERCOMPRESS_USE_FIRESTORE" }], { gateway: true }), /overrides/);
    assert.throws(() => secrets([{ Name: "SC_CP_ALLOW_STUB" }]), /overrides/);
  });
}
