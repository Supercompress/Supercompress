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
