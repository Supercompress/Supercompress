const assert = require("node:assert/strict");
const { getPersistenceConfig, getPersistenceReadiness } = require("./persistence-config");

const envNames = [
  "VERCEL_ENV", "NODE_ENV", "SC_FORCE_PROD", "FLY_APP_NAME", "FLY_MACHINE_ID",
  "SUPERCOMPRESS_USE_FIRESTORE", "SUPERCOMPRESS_ALLOW_GIST", "SUPERCOMPRESS_DISABLE_GIST",
  "SUPERCOMPRESS_STORE_GIST_ID", "SUPERCOMPRESS_STORE_GITHUB_TOKEN", "GITHUB_TOKEN",
];
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
function configure(values = {}) {
  for (const name of envNames) delete process.env[name];
  Object.assign(process.env, values);
}

try {
  configure();
  assert.equal(getPersistenceConfig().backend, "claims");
  for (const value of ["1", "true", "yes", " TRUE ", "Yes"]) {
    configure({ SUPERCOMPRESS_USE_FIRESTORE: value });
    assert.equal(getPersistenceConfig().backend, "firestore");
  }
  for (const value of ["", "0", "false", "on"]) {
    configure({ SUPERCOMPRESS_USE_FIRESTORE: value });
    assert.equal(getPersistenceConfig().backend, "claims");
  }

  const gist = {
    SUPERCOMPRESS_STORE_GIST_ID: "private-gist-id",
    SUPERCOMPRESS_STORE_GITHUB_TOKEN: "private-github-token",
  };
  for (const runtime of [
    {}, { NODE_ENV: "production" }, { VERCEL_ENV: "production" },
    { SC_FORCE_PROD: " 1 " }, { FLY_APP_NAME: "api" }, { FLY_MACHINE_ID: "machine" },
  ]) {
    for (const allow of ["", "1", "true", " 1 "]) {
      for (const disable of ["", "1", "true", " 1 "]) {
        configure({ ...gist, ...runtime, SUPERCOMPRESS_ALLOW_GIST: allow, SUPERCOMPRESS_DISABLE_GIST: disable });
        const production = Object.keys(runtime).length > 0;
        const expected = disable.trim() !== "1" && (!production || allow.trim() === "1");
        const config = getPersistenceConfig();
        assert.equal(config.production, production);
        assert.equal(config.gistAllowed, expected);
        assert.equal(config.gistBreakGlass, production && expected);
        assert.equal(config.backend, expected ? "gist" : "claims");
      }
    }
  }
  for (const missing of Object.keys(gist)) {
    configure(gist);
    delete process.env[missing];
    assert.equal(getPersistenceConfig().gistAllowed, false);
  }
  configure({ SUPERCOMPRESS_STORE_GIST_ID: "private-gist-id", GITHUB_TOKEN: "fallback-token" });
  assert.equal(getPersistenceConfig().gistAllowed, true);
  configure({ ...gist, SUPERCOMPRESS_USE_FIRESTORE: "yes" });
  assert.equal(getPersistenceConfig().backend, "firestore");
  assert.equal(getPersistenceReadiness().storeBackend, "firestore");
  assert.equal(getPersistenceReadiness({ firestoreUnavailable: true }).storeBackend, "gist");
  assert.equal(getPersistenceReadiness({ lastSuccessfulBackend: "firestore" }).firestoreState, "observed");
  process.env.SUPERCOMPRESS_DISABLE_GIST = "1";
  const unavailable = getPersistenceReadiness({ firestoreUnavailable: true, lastSuccessfulBackend: "secret" });
  assert.equal(unavailable.storeBackend, "memory");
  assert.equal(unavailable.firestoreState, "unavailable");
  assert.equal(unavailable.readiness, "process-local-only");
  assert.equal(unavailable.lastSuccessfulBackend, null);
  assert.equal(unavailable.connectivityVerified, false);
  assert.equal(unavailable.retirement.status, "blocked");
  assert.equal(unavailable.retirement.reconciliationVerified, false);
  const serialized = JSON.stringify(unavailable);
  for (const secret of [...Object.values(gist), "fallback-token"]) assert.ok(!serialized.includes(secret));
  console.log("persistence-config.test.js: ok");
} finally {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
