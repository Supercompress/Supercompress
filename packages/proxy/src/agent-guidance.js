/**
 * Shared agent-facing guidance. Every instruction block (CLAUDE.md / AGENTS.md,
 * Cursor rule, fx, Grok, agent plugins) builds from these lines so they cannot
 * drift apart.
 *
 * Keep these free of "## " headings: the uninstall stripper for older blocks
 * stops at the next heading.
 */

const COMPRESS_INTRO =
  "Compress bulky context before it fills your context window. Never compress the user's request.";

const COMPRESS_WHAT = [
  "**Compress** with MCP `compress_context` (`context` = only the new bulky text, `query` = the user's request, verbatim):",
  "- tool output, logs, stack traces, test and build runs, diffs over ~150 lines (~2K tokens)",
  "- long file reads, grep / search results, web pages, docs, RAG chunks, pasted documents",
  "- earlier conversation you no longer need word for word",
  "",
  "**Don't compress** the user's request, short output, or code you are about to edit or patch — edits need the exact text.",
];

function compressSteps(inboxPath, { tool = "compress_context", connect = "connect_account" } = {}) {
  return [
    `1. If \`${inboxPath}\` exists, Read it first — hooks already compressed the latest large tool result.`,
    `2. Otherwise call \`${tool}\` with only the new dump (not the whole conversation) and work from the returned digest instead of the raw text.`,
    "3. If the digest dropped a line you need, re-read just that part of the source.",
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
