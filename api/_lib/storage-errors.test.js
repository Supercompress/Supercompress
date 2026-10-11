const assert = require("assert");
const {
  STORAGE_UNAVAILABLE_DETAIL,
  storageUnavailableError,
  isFirestoreUnavailable,
  mapStorageError,
} = require("./storage-errors");

{
  const err = storageUnavailableError();
  assert.strictEqual(err.status, 503);
  assert.strictEqual(err.code, "temporarily_unavailable");
  assert.match(err.message, /Cloud Firestore/);
  assert.ok(!/400/.test(err.message));
}

{
  const raw = new Error("7 PERMISSION_DENIED: Cloud Firestore API has not been used in project x");
  raw.code = 7;
  assert.strictEqual(isFirestoreUnavailable(raw), true);
  const mapped = mapStorageError(raw);
  assert.strictEqual(mapped.status, 503);
  assert.strictEqual(mapped.code, "temporarily_unavailable");
  assert.strictEqual(mapped.message, STORAGE_UNAVAILABLE_DETAIL);
}

{
  const raw = new Error("Could not load the default credentials");
  assert.strictEqual(isFirestoreUnavailable(raw), true);
  assert.strictEqual(mapStorageError(raw).status, 503);
}

{
  const raw = new Error("The database (default) does not exist for project x");
  assert.strictEqual(isFirestoreUnavailable(raw), true);
}

{
  const validation = new Error("redirect_uris required");
  validation.status = 400;
  validation.code = "invalid_client_metadata";
  const mapped = mapStorageError(validation);
  assert.strictEqual(mapped, validation);
  assert.strictEqual(mapped.status, 400);
}

{
  const already = storageUnavailableError();
  assert.strictEqual(mapStorageError(already), already);
}

console.log("storage-errors.test.js: ok");
