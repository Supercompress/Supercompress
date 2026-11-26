const assert = require("node:assert/strict");

const envNames = [
  "VERCEL_ENV", "NODE_ENV", "SC_FORCE_PROD", "FLY_APP_NAME", "FLY_MACHINE_ID",
  "SUPERCOMPRESS_USE_FIRESTORE", "SUPERCOMPRESS_ALLOW_GIST", "SUPERCOMPRESS_DISABLE_GIST",
  "SUPERCOMPRESS_STORE_GIST_ID", "SUPERCOMPRESS_STORE_GITHUB_TOKEN", "GITHUB_TOKEN",
];
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const moduleNames = ["./store", "./auth", "./gist-store", "./persistence-config", "firebase-admin"];
const originalModules = new Map(moduleNames.map((name) => {
  const id = require.resolve(name);
  return [id, require.cache[id]];
}));
const { gistConfigured } = require("./gist-store");
let firestoreCalls = 0;
let gistCalls = 0;
let firestoreFails = false;
let gistFails = false;
const history = { subscriptions: { customer: { legacy_invoice: "preserve-me" } }, _version: 4 };
const document = {
  async get() {
    firestoreCalls += 1;
    if (firestoreFails) throw Object.assign(new Error("unavailable"), { code: 7 });
    return { exists: true, data: () => structuredClone(history) };
  },
  async set() { firestoreCalls += 1; },
};
const database = {
  doc: () => document,
  runTransaction: async (callback) => callback({ get: () => document.get(), set: () => { firestoreCalls += 1; } }),
};
function stub(name, exports) {
  const id = require.resolve(name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
function freshStore(values = {}) {
  for (const name of envNames) delete process.env[name];
  Object.assign(process.env, values);
  delete require.cache[require.resolve("./store")];
  return require("./store");
}

async function main() {
  stub("./auth", { initFirebaseAdmin: () => true });
  stub("firebase-admin", { firestore: () => database });
  stub("./gist-store", {
    gistConfigured,
    loadGistStore: async () => {
      gistCalls += 1;
      if (gistFails) throw new Error("gist unavailable");
      return structuredClone(history);
    },
    saveGistStore: async () => { gistCalls += 1; },
  });
  delete require.cache[require.resolve("./persistence-config")];
  const gist = { SUPERCOMPRESS_STORE_GIST_ID: "test-id", SUPERCOMPRESS_STORE_GITHUB_TOKEN: "test-token" };
  let store = freshStore({ ...gist, FLY_APP_NAME: "production-api" });
  assert.equal(store.persistenceStatus().backend, "claims");
  assert.equal(store.persistenceStatus().lastSuccessfulBackend, null);
  assert.equal(firestoreCalls + gistCalls, 0);
  await store.mutateStore((data) => { data.subscriptions = structuredClone(history.subscriptions); });
  assert.deepEqual((await store.loadStore({ forceRemote: true })).subscriptions, history.subscriptions);
  await store.saveStore(await store.loadStore());
  assert.equal(store.persistenceStatus().lastSuccessfulBackend, "memory");
  assert.equal(firestoreCalls + gistCalls, 0);

  store = freshStore({ ...gist, FLY_APP_NAME: "production-api", SUPERCOMPRESS_ALLOW_GIST: "1" });
  assert.deepEqual((await store.loadStore()).subscriptions, history.subscriptions);
  await store.mutateStore((data) => { data.connections.new = { uid: "user" }; });
  assert.equal(store.persistenceStatus().lastSuccessfulBackend, "gist");
  assert.ok(gistCalls > 0);
  assert.equal(firestoreCalls, 0);

  store = freshStore({ SUPERCOMPRESS_USE_FIRESTORE: "true" });
  assert.equal(store.persistenceStatus().firestoreState, "not-probed");
  assert.deepEqual((await store.loadStore()).subscriptions, history.subscriptions);
  await store.saveStore(await store.loadStore());
  await store.mutateStore((data) => { assert.deepEqual(data.subscriptions, history.subscriptions); });
  assert.equal(store.persistenceStatus().lastSuccessfulBackend, "firestore");
  assert.equal(store.persistenceStatus().firestoreState, "observed");

  firestoreFails = true;
  store = freshStore({ ...gist, FLY_MACHINE_ID: "machine", SUPERCOMPRESS_USE_FIRESTORE: "1" });
  const previousGistCalls = gistCalls;
  await store.loadStore({ forceRemote: true });
  assert.equal(gistCalls, previousGistCalls);
  assert.equal(store.persistenceStatus().firestoreState, "unavailable");
  assert.equal(store.persistenceStatus().storeBackend, "memory");
  await assert.rejects(store.saveStore(history), { status: 503 });

  store = freshStore({ ...gist, SUPERCOMPRESS_USE_FIRESTORE: "1", SUPERCOMPRESS_ALLOW_GIST: "1", FLY_MACHINE_ID: "machine" });
  assert.deepEqual((await store.loadStore()).subscriptions, history.subscriptions);
  assert.equal(store.persistenceStatus().lastSuccessfulBackend, "gist");
  gistFails = true;
  store = freshStore(gist);
  await assert.rejects(store.loadStore(), /gist unavailable/);
  assert.equal(store.persistenceStatus().lastSuccessfulBackend, null);
  assert.equal(store.persistenceStatus().retirement.status, "blocked");
  console.log("store-persistence.test.js: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const [id, cached] of originalModules) {
    if (cached === undefined) delete require.cache[id];
    else require.cache[id] = cached;
  }
});
