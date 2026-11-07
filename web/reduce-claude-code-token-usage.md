# Reduce Claude Code Token Usage: Keep Only the Lines That Matter

Canonical HTML: https://www.supercompress.dev/reduce-claude-code-token-usage

This Markdown file is a noindex convenience extract of the HTML page. Cite the HTML URL.

# Reduce Claude Code Token Usage: Keep Only the Lines That Matter

Every Claude Code turn resends the session so far, and most of that session is tool output: file reads, Bash and test logs, Grep hits and MCP results. Here is where Claude Code tokens go, the built-in commands and habits that cut them, and how SuperCompress keeps only the lines that answer the question Claude is working on.

    [All coding agents](https://www.supercompress.dev/coding-agent-token-usage)
    [Cursor](https://www.supercompress.dev/reduce-cursor-token-usage)
    [Codex](https://www.supercompress.dev/reduce-codex-token-usage)
    [Hermes Agent](https://www.supercompress.dev/reduce-hermes-agent-token-usage)
    [Goose](https://www.supercompress.dev/reduce-goose-token-usage)
    [MCP token reduction](https://www.supercompress.dev/mcp-token-reduction)
    [Approaches compared](https://www.supercompress.dev/context-compression-for-coding-agents)
    [Rate-limit runway](https://www.supercompress.dev/coding-agent-rate-limits)
    [FAQ](https://www.supercompress.dev/faq)

      **In short:** run `/context` to see what is filling the window, keep `CLAUDE.md` short, turn off MCP servers you are not using and start a fresh session per task. Then run `npm install -g supercompress-proxy && supercompress setup` so Claude Code can compress bulky tool output against your current question.

Related: [compare context compression tools](https://www.supercompress.dev/alternatives) you can put in front of Claude Code, including [Headroom alternatives](https://www.supercompress.dev/alternatives/headroom) and [Caveman alternatives](https://www.supercompress.dev/alternatives/caveman). See also [compress Claude Code tool output](https://www.supercompress.dev/compress-claude-code-tool-output), [/compact vs /clear vs compression](https://www.supercompress.dev/claude-code-compact-vs-clear-vs-compression), and [check Claude Code rate limits from the terminal](https://www.supercompress.dev/coding-agent-rate-limits).

Compare every tool: [context compression and token tools compared](https://www.supercompress.dev/comparisons), [Headroom alternatives](https://www.supercompress.dev/headroom-alternatives), and the [complete guide to context compression](https://www.supercompress.dev/context-compression).

## Where Claude Code tokens go

- **The session so far.** Earlier messages and every tool result still in the conversation go back to the model on each turn.
- **Tool results.** Read returns the whole file, Bash returns the whole log and Grep returns every hit, even when the question is about one function or one failing test.
- **MCP servers.** Each enabled server adds its tool definitions, and MCP results can be very large.
- **Memory files.** `CLAUDE.md` files are loaded into every session.

## Habits that cut Claude Code token usage for free

1. **Look before you cut.** `/context` shows which parts of the window are taken by the system prompt, tools, memory files and messages.
2. **One task per session.** Use `/clear` when you switch to unrelated work, so old tool output stops riding along.
3. **Compact with a focus.** `/compact` with a short instruction, such as `/compact keep the auth bug details`, summarizes the session around what you still need.
4. **Keep `CLAUDE.md` lean.** Move long reference material into files Claude reads on demand.
5. **Disable MCP servers you are not using.** Their tool definitions are sent with every request.
6. **Use subagents for wide searches.** A subagent explores in its own context and returns a short report to the main session.

These habits shrink what goes in. They don't help when the agent genuinely needs to run a test suite or read a large file and only a few lines of the output matter. That is the part SuperCompress handles.

## How SuperCompress works

SuperCompress is hosted, extractive and query-aware. Your agent sends a large block of context (a log, a diff, a file read, an MCP result) together with the question it is working on. Our Neural Keep model scores the lines against that question, keeps the original lines that answer it, and drops the rest. It never rewrites or summarizes, so file paths, error messages, IDs and code come back exactly as they were. The question itself is never compressed.

Every compress call reports `original_tokens` and `kept_tokens`, so you can see what was dropped on your own work instead of trusting a headline number. The `usage_summary` MCP tool shows totals per agent for your account.

## What `supercompress setup` adds to Claude Code

| What | Where | What it does |
| --- | --- | --- |
| **MCP server** | `~/.claude.json` | Gives the agent the `compress_context`, `connect_account` and `usage_summary` tools. |
| **Instructions** | `~/.claude/CLAUDE.md` | A short SuperCompress block telling Claude to pass bulky dumps (logs, diffs, large reads) through `compress_context` with your request as the query, and never to compress the request itself. |
| **Hooks** | `~/.claude/settings.json` | `UserPromptSubmit` and `PostToolUse` hooks. After large tool calls, the hook compresses the new output against your request and passes the kept lines to Claude as extra context. |

## Prefer the Claude Code plugin?

You can install SuperCompress from inside Claude Code instead:

```
/plugin marketplace add Supercompress/Supercompress
/plugin install supercompress@supercompress
```

To connect only the hosted MCP server with an API key from the dashboard:

```
claude mcp add --transport http supercompress https://www.supercompress.dev/api/mcp --header "Authorization: Bearer sc_live_YOUR_KEY"
```

## Install

```
npm install -g supercompress-proxy && supercompress setup
```

Setup links your SuperCompress account in the browser, detects the coding agents on the machine and wires each one. Restart the agent so it loads the new MCP server. Then check what is wired up:

```
supercompress doctor
```

`doctor` prints a per-agent health check. `supercompress uninstall` removes only the entries SuperCompress added. Setup backs up each config file before it edits it.

## How this compares with built-in compaction

`/compact` and auto-compact summarize the whole conversation once it is already large. SuperCompress works earlier and on one tool result at a time: it keeps the original lines from a new dump that answer the current question, before that dump piles up in the session. The two work well together. See [Claude Code context limit](https://www.supercompress.dev/claude-code-context-limit) for the full picture and [Claude Code MCP output too large](https://www.supercompress.dev/claude-code-mcp-output-too-large) for oversized MCP results.

## When to skip it

- Short sessions with small tool results. There is little to drop.
- Files the agent is about to edit line by line. It needs those in full.
- Work where every byte must be passed through unchanged for compliance reasons.

## FAQ

### Why does Claude Code use so many tokens?

Each turn resends the session so far, and that session fills up with tool results: file reads, Bash and test output, Grep hits and MCP results. Memory files and the tool definitions of every enabled MCP server are added to every request too.

### Does SuperCompress work with a Claude subscription login?

Yes. SuperCompress does not touch how Claude Code talks to Anthropic. It adds an MCP server, instructions and hooks, so you keep your normal Claude Code login.

### Does SuperCompress change how I sign in to Claude Code?

No. You keep your normal Claude Code login and models. SuperCompress adds an MCP server and instructions to Claude Code; your model traffic does not pass through SuperCompress.

### Does SuperCompress summarize what Claude Code reads?

No. It is extractive. The lines it keeps are copied from the original output, so file paths, error messages and code stay exactly as they were.

### How do I undo the Claude Code setup?

Run `supercompress uninstall`. It removes only the entries SuperCompress added, so your other MCP servers, hooks and instructions stay as they were.

[Get API key](https://www.supercompress.dev/dashboard?signup=1)
      [Coding agents guide](https://docs.supercompress.dev/coding-agents)
      [All coding agents](https://www.supercompress.dev/coding-agent-token-usage)
