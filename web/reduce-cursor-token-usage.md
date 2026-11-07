# Reduce Cursor token usage: keep the lines your agent needs

Canonical HTML: https://www.supercompress.dev/reduce-cursor-token-usage

This Markdown file is a noindex convenience extract of the HTML page. Cite the HTML URL.

A long Cursor agent thread sends the conversation back to the model on every turn, and most of that conversation is tool output: file reads, shell and test logs, search hits and MCP results. Here is where Cursor tokens go, the habits that cut them for free, and how SuperCompress keeps only the lines that answer the question your agent is working on.

- [All coding agents](https://www.supercompress.dev/coding-agent-token-usage)
- [Claude Code](https://www.supercompress.dev/reduce-claude-code-token-usage)
- [Goose](https://www.supercompress.dev/reduce-goose-token-usage)
- [MCP token reduction](https://www.supercompress.dev/mcp-token-reduction)
- [FAQ](https://www.supercompress.dev/faq)
- [Coding agents](https://docs.supercompress.dev/coding-agents)
- [MCP tool output compression](https://www.supercompress.dev/mcp-tool-output-compression)
- [Playground](https://www.supercompress.dev/playground)
- [vs RTK](https://www.supercompress.dev/supercompress-vs-rtk)
- [vs Headroom](https://www.supercompress.dev/supercompress-vs-headroom)
- [Changelog](https://www.supercompress.dev/changelog)

**In short:** keep each chat to one task, attach only the files you need, and trim rules and MCP servers you don't use. Then run `npm install -g supercompress-proxy && supercompress setup` so your agent can compress bulky tool output against your current question. SuperCompress keeps the original lines that answer it, drops the rest, and reports `original_tokens` and `kept_tokens` on every call.

## Where Cursor tokens go

Every agent turn in Cursor carries more than your message. The model also reads:

- **The thread so far.** Earlier messages and every tool result that is still in the conversation go back to the model on the next turn.
- **Tool output.** A file read returns the whole file, a shell command returns the whole log, and a search returns every hit, even when the question is about one function or one failing test.
- **Attachments and retrieval.** Files you attach and code the agent pulls in from the codebase.
- **Always-on rules and MCP tools.** Rules marked to always apply, and the definitions of every enabled MCP server.

## Habits that cut Cursor token usage for free

1. **One task per chat.** Start a new chat when you switch to unrelated work, so old tool output stops riding along.
2. **Attach the files you mean.** Point the agent at specific files instead of broad codebase searches when you already know where the change goes.
3. **Ignore what the agent never needs.** Add build output, vendored code, lockfiles and generated files to `.cursorignore`.
4. **Trim always-on rules.** Keep rules short, and scope the long ones to the files they apply to.
5. **Turn off MCP servers you are not using.** Each enabled server adds its tool definitions to the request.

These habits shrink what goes in. They don't help when the agent genuinely needs to run a test suite or read a large file and only a few lines of the output matter. That is the part SuperCompress handles.

## How SuperCompress reduces Cursor token usage

SuperCompress is hosted, extractive and query-aware. It takes a large block of context plus the current question, keeps the original lines that answer that question, and drops the rest. It never rewrites or summarizes, so file paths, error messages and code stay exactly as they were. The question itself is never compressed.

When `supercompress setup` detects Cursor, it adds three things:

| What | Where | What it does |
| --- | --- | --- |
| **MCP server** | `~/.cursor/mcp.json` | Gives the agent the `compress_context`, `connect_account` and `usage_summary` tools. |
| **Always-on rule** | `~/.cursor/rules/supercompress.mdc` | Tells the agent to compress bulky context (tool dumps, pasted files, long logs) with `compress_context`, using your request as the query, and never to compress the request itself. |
| **Hooks** | `~/.cursor/hooks.json` and `~/.cursor/hooks/supercompress/` | After large Read, Shell, Grep, search and MCP tool calls, the hook compresses the new output, keeping errors, stack traces and the files and symbols it names, and hands the agent the kept lines alongside it. |

Setup merges its entries into Cursor's existing `mcp.json` and `hooks.json`, so your other servers and hooks stay as they were. You keep your normal Cursor login and models.

## Install in Cursor

```
npm install -g supercompress-proxy && supercompress setup
```

Restart Cursor so it loads the new MCP server and hooks. Then check what is wired up:

```
supercompress doctor
```

`doctor` shows the account, the MCP server and the hooks for each agent it finds. Run `supercompress uninstall` to remove the SuperCompress entries again. The full harness list is in the [coding agents guide](https://docs.supercompress.dev/coding-agents).

## Measure it on your own work

Every compress response reports `original_tokens` and `kept_tokens`, so you see the saving call by call on your own repo instead of trusting a headline number. The `usage_summary` MCP tool shows totals for your account. For the full picture in Cursor, compare your usage over a normal week with and without it.

## Other ways to cut Cursor tokens

- **Local proxies** such as Headroom's `wrap cursor` start a proxy and have you point Cursor's model settings at it. SuperCompress works through MCP, a rule and hooks instead, so Cursor keeps talking to its own models.
- **Command filters** such as RTK rewrite shell commands so their output is shorter before the agent reads it. They work on known command formats; SuperCompress works on any text and decides what to keep from your current question. See [SuperCompress vs RTK](https://www.supercompress.dev/supercompress-vs-rtk).
- **MCP-specific tools** go after tool definitions or JSON structure. See [MCP tool output compression](https://www.supercompress.dev/mcp-tool-output-compression) for how those compare.

These approaches can be combined. The habits above shrink what goes in, and SuperCompress decides which parts of what comes back are worth reading. See [context compression for coding agents](https://www.supercompress.dev/context-compression-for-coding-agents) for the same comparison across tools.

## When to skip it

- Short chats with small tool results. There is little to drop.
- Files the agent is about to edit line by line. It needs those in full.

## Pricing

Current plans and your free allowance are shown in the [dashboard](https://www.supercompress.dev/dashboard?signup=1).

## FAQ

### Why is my Cursor token usage so high?

Agent threads send the conversation back to the model on every turn, and that conversation fills up with tool output: file reads, shell and test output, search results and MCP tool results. Attached files, always-on rules and enabled MCP servers add more on every request.

### Does SuperCompress change how I sign in to Cursor?

No. You keep your normal Cursor login and models. SuperCompress adds an MCP server, an always-on rule and hooks to Cursor; your model traffic does not pass through SuperCompress.

### Does SuperCompress rewrite or summarize what Cursor reads?

No. It is extractive. The lines it keeps are copied from the original output, so file paths, error messages and code stay exactly as they were.

### How do I see what was removed?

Every compress response reports `original_tokens` and `kept_tokens`. The `usage_summary` MCP tool shows totals for your account.

### How do I undo the Cursor setup?

Run `supercompress uninstall`. Setup only adds its own entries to Cursor's `mcp.json` and `hooks.json`, and uninstall removes only those, so unrelated hooks and servers stay as they were.

Related: [Cursor MCP context compression](https://www.supercompress.dev/cursor-mcp-context-compression).

[Get API key](https://www.supercompress.dev/dashboard?signup=1) [Coding agents guide](https://docs.supercompress.dev/coding-agents)
