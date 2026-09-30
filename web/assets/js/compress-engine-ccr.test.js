/**
 * Unit tests for CCR storage-key safety.
 * Run: node web/assets/js/compress-engine-ccr.test.js
 *
 * simpleHash is a 32-bit rolling hash passed through Math.abs, so roughly 31
 * bits of key space: two different texts of the same length do collide. The
 * invariant these tests pin is that a collision may cause a MISS, but must
 * never hand back an original that does not belong to the key asked for.
 */
const assert = require("assert");

require("./compress-engine.js");
const E = globalThis.SuperCompressEngine;
const model = require("../data/model.json");

// A known colliding pair, found by scanning a fixed-width numeric field.
// Both are 42 characters and both key to 16eb65e4_2a.
const A = "ERROR checksum mismatch on shard 003499399";
const B = "ERROR checksum mismatch on shard 004051035";

assert.strictEqual(A.length, B.length, "the pair must be equal length");
assert.notStrictEqual(A, B, "the pair must be different texts");
assert.strictEqual(
  E.simpleHash(A),
  E.simpleHash(B),
  "this pair is the regression fixture: it must still collide"
);

const ccr = (text) =>
  E.compressCCR(text, "which shard is corrupt?", model, {
    enableMarkers: true,
    includeAnnotations: false,
  });

// Store A first, then B under the same key.
const first = ccr(A);
const second = ccr(B);

// The key belongs to whoever stored it first; the loser gets no key at all
// rather than a key pointing at someone else's content.
assert.ok(first.ccr, "first compression must produce a ccr envelope");
assert.strictEqual(first.ccr.hash, E.simpleHash(A), "first writer owns the key");
assert.strictEqual(
  second.ccr.hash,
  null,
  "a colliding second writer must not be handed the key it does not own"
);

// The invariant that matters: whatever comes back under a key must actually
// hash to that key. Before the fix, retrieving B's key returned A's text.
for (const key of [E.simpleHash(A), E.simpleHash(B)]) {
  const got = E.ccrRetrieve(key);
  if (got !== null) {
    assert.strictEqual(
      E.simpleHash(got),
      key,
      "retrieved original must hash back to the key it was fetched with"
    );
    assert.strictEqual(got, A, "the stored original is the first writer's");
  }
}

// A marker is only emitted for a block the engine actually owns, so no
// retrieve_url can point at content belonging to a different original.
for (const hash of second.ccr.marker_hashes || []) {
  const got = E.ccrRetrieve(hash);
  if (got !== null) {
    assert.strictEqual(E.simpleHash(got), hash, "every emitted marker must resolve to its own content");
  }
}

// Re-storing identical content is not a collision and must keep working.
const again = ccr(A);
assert.strictEqual(again.ccr.hash, E.simpleHash(A), "identical content keeps its key");
assert.strictEqual(E.ccrRetrieve(E.simpleHash(A)), A, "identical content still retrievable");

console.log("compress-engine-ccr.test.js: ok");
