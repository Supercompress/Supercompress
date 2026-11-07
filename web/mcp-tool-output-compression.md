# MCP tool output compression: keep the lines that answer the question

Canonical HTML: https://www.supercompress.dev/mcp-tool-output-compression

This Markdown file is a noindex convenience extract of the HTML page. Cite the HTML URL.

MCP tools return whatever the server sends back: full JSON objects, long logs, whole files, pages of search hits. All of it lands in the model's context, and it is paid for again on every turn it stays there. SuperCompress compresses MCP tool results against the question your agent is working on, so the model reads the lines that answer it instead of the whole dump.

- [All coding agents](https://www.supercompress.dev/coding-agent-token-usage)
- [Claude Code](https://www.supercompress.dev/reduce-claude-code-token-usage)
- [MCP token reduction](https://www.supercompress.dev/mcp-token-reduction)
- [FAQ](https://www.supercompress.dev/faq)
- [Coding agents](https://docs.supercompress.dev/coding-agents)
- [API reference](https://docs.supercompress.dev/api-reference)
- [Playground](https://www.supercompress.dev/playground)
- [vs RTK](https://www.supercompress.dev/supercompress-vs-rtk)
- [vs Headroom](https://www.supercompress.dev/supercompress-vs-headroom)
- [Changelog](https://www.supercompress.dev/changelog)

**In short:** send SuperCompress the tool result plus the current question. It keeps the original lines that answer that question and drops the rest. It never rewrites or summarizes, and every response reports `original_tokens` and `kept_tokens`.

Related: [compare context compression tools](https://www.supercompress.dev/alternatives) that sit on tool output, including [Headroom alternatives](https://www.supercompress.dev/alternatives/headroom), [Caveman alternatives](https://www.supercompress.dev/alternatives/caveman) and [ScaleDown alternatives](https://www.supercompress.dev/alternatives/scaledown). See also [MCP context bloat](https://www.supercompress.dev/mcp-context-bloat) and [how to reduce tool call output tokens](https://www.supercompress.dev/reduce-tool-call-output-tokens).

Compare every tool: [context compression and token tools compared](https://www.supercompress.dev/comparisons), [Headroom alternatives](https://www.supercompress.dev/headroom-alternatives), and the [complete guide to context compression](https://www.supercompress.dev/context-compression).

## Why MCP token usage grows

Most MCP servers wrap an API and pass its response straight through. A single call can return dozens of records with every field filled in, a full build log, or an entire file when the agent needed one function. The model has to read all of it to find the part that matters, and the tool result keeps riding along in the conversation on later turns.

- **API wrappers** return complete objects: nested metadata, URLs, timestamps and fields nobody asked about.
- **Logs and CI output** bury one failing line under thousands of passing ones.
- **File reads and search tools** return whole files or long hit lists when the question is about one symbol.

## How SuperCompress compresses MCP tool results

SuperCompress is hosted, extractive and query-aware.

1. **You send two things:** the tool output as `context`, and the current question or task as `query`. The query is never compressed.
2. **It picks lines, it does not write them.** SuperCompress keeps the original lines from the tool output that answer that question and drops the rest. Nothing is paraphrased, so IDs, paths, error messages and code stay exactly as the tool returned them.
3. **You see the result.** Every response reports `original_tokens` and `kept_tokens`, so the saving is measured on your own traffic, call by call.

## Set it up in your coding agent

One command finds the coding agents on your machine and adds the SuperCompress MCP server and hooks to each of them:

```
npm install -g supercompress-proxy && supercompress setup
```

Your agent then has three MCP tools:

| Tool | What it does |
| --- | --- |
| `compress_context` | Takes a bulky `context` (tool output, logs, diffs, files) and the user's `query`, and returns the kept lines with `original_tokens` and `kept_tokens`. |
| `connect_account` | Links the agent to your SuperCompress account. |
| `usage_summary` | Shows token totals and quota for the connected account. |

Run `supercompress doctor` at any time to check what is wired up. The full harness list is in the [coding agents guide](https://docs.supercompress.dev/coding-agents). Cursor-specific steps are on how to [reduce Cursor token usage](https://www.supercompress.dev/reduce-cursor-token-usage). Claude Code-specific steps are on how to [reduce Claude Code token usage](https://www.supercompress.dev/reduce-claude-code-token-usage).

## Building your own MCP host or agent

If you run the agent loop yourself, compress each large tool result before you append it to the messages you send to the model. The hosted MCP endpoint is:

```
https://www.supercompress.dev/api/mcp
```

Or call the HTTP API directly with an API key from the [dashboard](https://www.supercompress.dev/dashboard?signup=1):

```
curl -X POST https://www.supercompress.dev/api/v1/compress \
  -H "X-API-Key: sc_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"context": "<the MCP tool result>", "query": "<what the agent is trying to answer>"}'
```

Request fields and response fields are in the [API reference](https://docs.supercompress.dev/api-reference).

## How it compares to other ways to reduce MCP token usage

There are two separate costs in an MCP setup: the tool definitions the model sees on every turn, and the tool results that come back from each call. Different tools go after different parts.

| Approach | What it changes | How it decides what to keep |
| --- | --- | --- |
| **SuperCompress** | The content of a tool result (or any large context) | Against the current question: keeps the original lines that answer it and drops the rest |
| **compressmcp** | Large JSON tool responses in Claude Code | Keeps every value and abbreviates repeated JSON keys, with a key dictionary the model reads to decode them |
| **Bifrost Code Mode** | Tool definitions and multi-step tool workflows across many MCP servers | Exposes four meta-tools; the model writes Python (Starlark) that runs the tool calls in a sandbox and returns only the final result |

These approaches do not exclude each other. Code Mode shrinks the tool catalog, key abbreviation shrinks JSON structure, and SuperCompress decides which parts of a result are worth reading for the question at hand.

## When it helps, and when to skip it

- **Good fit:** large, mixed tool results where only part of the output matters for the current question, such as logs, search hits, file reads and API responses with many records.
- **Skip it:** small results, or results the agent must see in full, such as a file it is about to edit line by line.

## Pricing

Current plans and your free allowance are shown in the [dashboard](https://www.supercompress.dev/dashboard?signup=1).

## FAQ

### Does SuperCompress rewrite or summarize tool results?

No. It is extractive. Every line it returns is copied from the original tool output.

### What do I send besides the tool output?

The current question or task. SuperCompress uses it to decide which lines to keep, and it never compresses the question itself.

### How do I check what was removed?

Each response includes `original_tokens` and `kept_tokens`. For account totals, call the `usage_summary` MCP tool.

[Get API key](https://www.supercompress.dev/dashboard?signup=1) [Coding agents guide](https://docs.supercompress.dev/coding-agents)
