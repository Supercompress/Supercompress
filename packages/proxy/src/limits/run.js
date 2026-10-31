#!/usr/bin/env node
/**
 * Standalone runway entry (no `supercompress` bin needed). setup copies this
 * directory to ~/.supercompress/runway/ so the Claude Code statusline keeps
 * working even if the npm/npx install that created it is cleaned up.
 */
require("./cli")
  .run(process.argv.slice(2))
  .catch((err) => {
    process.stderr.write(`supercompress runway: ${err.message}\n`);
    process.exitCode = 2;
  });
