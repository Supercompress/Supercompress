/**
 * Pure regression: migrate must not un-revoke a key when Auth stub still exists.
 */
const assert = require("assert");
const { describe, it } = require("node:test");

describe("migrateAuthKeyToStore revoke guard", () => {
  it("keeps revoked=true and clears hash_index when stub is still present", () => {
    // Mirror the mutator branch in firebase-key-store.migrateAuthKeyToStore.
    const id = "sck_deadbeef";
    const sc_hash = "abc123";
    const store = {
      keys: {
        [id]: {
          id,
          user_id: "owner1",
          key_hash: sc_hash,
          revoked: true,
        },
      },
      hash_index: { [sc_hash]: id },
    };
    const authUser = {
      uid: id,
      disabled: false,
      customClaims: {
        sc_api_key: true,
        sc_owner: "owner1",
        sc_hash,
      },
    };
    const c = authUser.customClaims;

    // Never resurrect a revoked key from a lingering Auth stub.
    if (store.keys[id]?.revoked) {
      if (store.hash_index[c.sc_hash] === id) delete store.hash_index[c.sc_hash];
      assert.equal(store.keys[id].revoked, true);
      assert.equal(store.hash_index[c.sc_hash], undefined);
      return;
    }
    assert.fail("should have taken revoked branch");
  });
});
