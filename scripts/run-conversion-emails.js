const { drainConversionMails } = require("../api/_lib/conversion-mail");

console.warn = () => console.error(JSON.stringify({ job: "conversion-emails", warning: "dependency_warning" }));

drainConversionMails({ dryRun: !process.argv.includes("--send") })
  .then(result => {
    console.log(JSON.stringify({ job: "conversion-emails", at: new Date().toISOString(), ...result }));
    if (result.failed || result.pending_review) process.exitCode = 1;
  })
  .catch(err => {
    const safeCodes = new Set([
      "payment_suppression_unavailable", "suppression_reconciliation_missing", "invalid_suppression_manifest",
      "conversion_state_path_missing", "conversion_disabled", "conversion_state_invalid",
    ]);
    const error = safeCodes.has(err?.message) ? err.message : "conversion_run_failed";
    console.error(JSON.stringify({ job: "conversion-emails", error }));
    process.exitCode = 1;
  });
