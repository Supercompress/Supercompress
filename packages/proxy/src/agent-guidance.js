/**
 * Shared agent-facing guidance. Every instruction block (CLAUDE.md / AGENTS.md,
 * Cursor rule, fx, Grok, agent plugins) builds from these lines so they cannot
 * drift apart.
 *
 * Keep these free of "## " headings: the uninstall stripper for older blocks
 * stops at the next heading.
 */

const COMPRESS_INTRO =
  "Keep bulky context out of your context window. Never compress the user's request.";

const COMPRESS_WHAT = [
  "Text already in your context costs the same whether or not you compress it afterwards, so savings come from keeping bulk out:",
  "- **Shell output may already be squeezed.** A `[supercompress: …]` footer means long, repetitive output (test runs, builds, installs, logs) was collapsed before you saw it. Errors, failures and the last lines are always kept, and the footer names a file with the full output.",
  "- **Read narrowly.** Filter long command output with `grep`, `tail` or `head`, and read big files by line range.",
  "- **Compress before a handoff.** When bulky text is about to go into another model call (a subagent or task prompt, a handoff note, an API request you are writing), call MCP `compress_context` (`context` = only the bulky text, `query` = the user's request, verbatim) and pass the digest instead.",
  "",
  "**Don't compress** the user's request, short output, text already in your context, or code you are about to edit or patch — edits need the exact text.",
];

function compressSteps(_inboxPath, { tool = "compress_context", connect = "connect_account" } = {}) {
  return [
    "1. If a squeezed output dropped a line you need, grep or sed the full-output file named in its footer.",
    `2. Before handing bulky text to another model call, run \`${tool}\` on only that text and pass the returned digest.`,
    "3. If a digest dropped a line you need, re-read just that part of the source.",
    `4. If it says the account is not linked, call \`${connect}\` once, give the user its link, then retry.`,
  ];
}

/** Runway runs locally (inside the installed package), never on the hosted API. */
function runwayRule({ tool = "runway_check" } = {}) {
  return (
    `**Rate limits:** before large or multi-step work, call MCP \`${tool}\` (or run \`supercompress limits --json\`; it runs locally). ` +
    "`go` → proceed; `scope: large` means quota would otherwise go unused, so take on more. " +
    "`land` → keep working, but commit or write a handoff note before each step. Don't stop early: a 5h window resets on its own and unused quota is lost. " +
    "`wait` → a window is actually used up: checkpoint, then wait `waitMinutes` or switch to a provider in `alternatives`. " +
    "`unknown` → no usage data; carry on and never guess a limit."
  );
}

module.exports = { COMPRESS_INTRO, COMPRESS_WHAT, compressSteps, runwayRule };
