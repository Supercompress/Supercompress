/**
 * Shared mapping for persistent-storage failures (Firestore disabled / Admin down).
 * Setup, device-link, and MCP OAuth/DCR must return this instead of a raw 400.
 */

const STORAGE_UNAVAILABLE_DETAIL =
  "Persistent storage is temporarily unavailable, so setup and OAuth registration cannot finish. Retry in a few minutes. If this continues, Cloud Firestore needs to be enabled on the SuperCompress project.";

function storageUnavailableError(detail) {
  const err = new Error(detail || STORAGE_UNAVAILABLE_DETAIL);
  err.status = 503;
  err.code = "temporarily_unavailable";
  return err;
}

function isFirestoreUnavailable(err) {
  if (!err) return false;
  if (err.status === 503 && err.code === "temporarily_unavailable") return true;
  const msg = String(err.message || "");
  const code = err.code;
  return (
    code === 7 ||
    code === "oauth_unavailable" ||
    msg.includes("Cloud Firestore API has not been used") ||
    msg.includes("Could not load the default credentials") ||
    msg.includes("SERVICE_DISABLED") ||
    msg.includes("The database (default) does not exist")
  );
}

function mapStorageError(err) {
  if (!err) return storageUnavailableError();
  if (err.status === 503 && err.code === "temporarily_unavailable") return err;
  if (isFirestoreUnavailable(err)) return storageUnavailableError();
  return err;
}

module.exports = {
  STORAGE_UNAVAILABLE_DETAIL,
  storageUnavailableError,
  isFirestoreUnavailable,
  mapStorageError,
};
