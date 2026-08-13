const assert = require("assert");
const { skipFirestore } = require("./firebase-off");

const prev = process.env.SUPERCOMPRESS_USE_FIRESTORE;
delete process.env.SUPERCOMPRESS_USE_FIRESTORE;
assert.strictEqual(skipFirestore(), true);

process.env.SUPERCOMPRESS_USE_FIRESTORE = "1";
assert.strictEqual(skipFirestore(), false);

process.env.SUPERCOMPRESS_USE_FIRESTORE = "true";
assert.strictEqual(skipFirestore(), false);

process.env.SUPERCOMPRESS_USE_FIRESTORE = "";
assert.strictEqual(skipFirestore(), true);

if (prev == null) delete process.env.SUPERCOMPRESS_USE_FIRESTORE;
else process.env.SUPERCOMPRESS_USE_FIRESTORE = prev;

console.log("firebase-off.test.js: ok");
