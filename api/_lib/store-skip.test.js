/**
 * When Firestore is opted out (prod default) and gist is off, mutateStore/saveStore
 * must not probe Firestore or throw 503.
 * Run: node api/_lib/store-skip.test.js
 */
const assert = require("assert");
const path = require("path");

const snap = {
  VERCEL_ENV: process.env.VERCEL_ENV,
  NODE_ENV: process.env.NODE_ENV,
  SUPERCOMPRESS_USE_FIRESTORE: process.env.SUPERCOMPRESS_USE_FIRESTORE,
  SUPERCOMPRESS_ALLOW_GIST: process.env.SUPERCOMPRESS_ALLOW_GIST,
  SUPERCOMPRESS_DISABLE_GIST: process.env.SUPERCOMPRESS_DISABLE_GIST,
};

function restore() {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function freshStore() {
  const id = require.resolve("./store");
  delete require.cache[id];
  delete require.cache[require.resolve("./firebase-off")];
  delete require.cache[require.resolve("./gist-store")];
  delete require.cache[require.resolve("./coding-agent-usage")];
  return require("./store");
}

async function main() {
  process.env.VERCEL_ENV = "production";
  process.env.NODE_ENV = "production";
  delete process.env.SUPERCOMPRESS_USE_FIRESTORE;
  delete process.env.SUPERCOMPRESS_ALLOW_GIST;
  delete process.env.SUPERCOMPRESS_DISABLE_GIST;

  const store = freshStore();

  const result = await store.mutateStore((s) => {
    s.coding_agent_usage = s.coding_agent_usage || {};
    s.coding_agent_usage.test_uid = { cursor: { requests: 1, tokens_in: 10 } };
    return "ok";
  });
  assert.strictEqual(result, "ok");

  const loaded = await store.loadStore({ forceRemote: true });
  assert.ok(loaded.coding_agent_usage?.test_uid?.cursor?.requests === 1);

  const saved = await store.saveStore(loaded);
  assert.ok(saved);
  assert.ok(saved._updated_at);

  // Must stay fast — no Auth listUsers scan on hot path.
  const t0 = Date.now();
  await store.loadStore({ forceRemote: true });
  assert.ok(Date.now() - t0 < 200, "loadStore hot path too slow");

  console.log("store-skip.test.js: ok");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restore();
    // Drop cached module so later tests see restored env.
    delete require.cache[require.resolve("./store")];
    delete require.cache[require.resolve("./firebase-off")];
  });
