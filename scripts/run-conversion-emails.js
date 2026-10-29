const { drainConversionMails } = require("../api/_lib/conversion-mail");

console.warn = () => console.error(JSON.stringify({ job: "conversion-emails", warning: "dependency_warning" }));

drainConversionMails({ dryRun: !process.argv.includes("--send") })
  .then(result => {
    console.log(JSON.stringify({ job: "conversion-emails", at: new Date().toISOString(), ...result }));
    if (result.failed || result.pending_review) process.exitCode = 1;
  })
  .catch(() => {
    console.error(JSON.stringify({ job: "conversion-emails", error: "conversion_run_failed" }));
    process.exitCode = 1;
  });

