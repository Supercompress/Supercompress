function reconciledMailSuppressions(env = process.env) {
  if (!env.SC_MAIL_SUPPRESSIONS_RECONCILED_AT) throw Error("suppression_reconciliation_missing");
  const hashes = JSON.parse(env.SC_MAIL_SUPPRESSION_SHA256 || "null");
  if (!Array.isArray(hashes) || hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
    throw Error("invalid_suppression_manifest");
  }
  return new Set(hashes);
}

module.exports = { reconciledMailSuppressions };
