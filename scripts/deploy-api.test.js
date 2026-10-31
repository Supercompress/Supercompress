"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

test("API preflight works without Fly credentials and cannot deploy", () => {
  const result = spawnSync("bash", ["scripts/deploy-api.sh", "--check"], {
    cwd: root,
    encoding: "utf8",
    env: { ...childEnv, FLYCTL_BIN: "/does-not-exist", FLY_ACCESS_TOKEN: "" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /API preflight passed/);
  assert.match(result.stdout, /tests \d+/);
});

test("API deployment stops before config, deploy or smoke when authentication fails", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sc-fly-deploy-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "flyctl");
  const calls = path.join(directory, "calls");
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SC_FLY_TEST_CALLS"\nexit 1\n', { mode: 0o700 });
  const result = spawnSync("bash", ["scripts/deploy-api.sh"], {
    cwd: root,
    encoding: "utf8",
    env: { ...childEnv, FLYCTL_BIN: executable, SC_FLY_TEST_CALLS: calls },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Fly authentication required/);
  assert.equal(fs.readFileSync(calls, "utf8"), "auth whoami\n");
});

test("deployment arguments cannot bypass the unreleased control-plane configuration", () => {
  for (const args of [["--env", "SC_CP_GATEWAY=1"], ["--config=other.toml"], ["--check", "--env=SC_CP_OPS=1"]]) {
    const result = spawnSync("bash", ["scripts/deploy-api.sh", ...args], {
      cwd: root, encoding: "utf8", env: childEnv,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Deployment overrides are disabled/);
  }
});

test("remote control-plane flag secrets stop deployment before changing production", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sc-fly-secret-guard-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "flyctl");
  const calls = path.join(directory, "calls");
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$SC_FLY_TEST_CALLS"',
    'if [ "$1" = "auth" ]; then exit 0; fi',
    'if [ "$1" = "secrets" ]; then printf \'[{"Name":"SC_CP_GATEWAY"}]\\n\'; exit 0; fi',
    "exit 99",
  ].join("\n"), { mode: 0o700 });
  const result = spawnSync("bash", ["scripts/deploy-api.sh"], {
    cwd: root, encoding: "utf8",
    env: { ...childEnv, FLYCTL_BIN: executable, SC_FLY_TEST_CALLS: calls },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /override disabled config/);
  assert.equal(fs.readFileSync(calls, "utf8"), "auth whoami\nsecrets list --app supercompress-api --json\n");
});
