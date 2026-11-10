# Context compression for coding agents: approaches compared

Canonical HTML: https://www.supercompress.dev/context-compression-for-coding-agents

This Markdown file is a noindex convenience extract of the HTML page. Cite the HTML URL.

There are now many tools that promise to shrink what a coding agent reads. They work at very different points: before a command runs, between the agent and an MCP server, on the whole request on the wire, or on one result against the current question. Here is how the approaches compare and how to test any of them on your own work.

- [All coding agents](https://www.supercompress.dev/coding-agent-token-usage)
- [MCP token reduction](https://www.supercompress.dev/mcp-token-reduction)
- [MCP tool output compression](https://www.supercompress.dev/mcp-tool-output-compression)
- [Claude Code context limit](https://www.supercompress.dev/claude-code-context-limit)
- [Rate-limit runway](https://www.supercompress.dev/coding-agent-rate-limits)
- [MCP output too large](https://www.supercompress.dev/claude-code-mcp-output-too-large)
- [FAQ](https://www.supercompress.dev/faq)
- [Verbatim lines vs token pruning](https://www.supercompress.dev/verbatim-lines-vs-token-pruning)

**In short:** pick by where your tokens go. Noisy shell commands: an output filter. Huge MCP results: a proxy or result compression. Long sessions: built-in compaction. Bulky output where only a few lines answer the current question: query-aware extraction such as SuperCompress. Measure on your own sessions, not on a vendor headline.

Related: [compare context compression tools](https://www.supercompress.dev/alternatives), including [Headroom alternatives](https://www.supercompress.dev/alternatives/headroom), [Caveman alternatives](https://www.supercompress.dev/alternatives/caveman), and the [Caveman Cloud alternative](https://www.supercompress.dev/alternatives/caveman-cloud). See also [what is context compression for AI agents](https://www.supercompress.dev/what-is-context-compression-for-ai-agents), [verbatim lines vs token pruning](https://www.supercompress.dev/verbatim-lines-vs-token-pruning), [context rot](https://www.supercompress.dev/context-rot), and [LLM context window too long](https://www.supercompress.dev/llm-context-window-too-long).

Compare every tool: [context compression and token tools compared](https://www.supercompress.dev/comparisons), [Headroom alternatives](https://www.supercompress.dev/headroom-alternatives), and the [complete guide to context compression](https://www.supercompress.dev/context-compression).

## The approaches

| Approach | Examples | Where it acts | Good fit | Watch out for |
| --- | --- | --- | --- | --- |
| **Command output filters** | RTK, chop | Rewrites or filters known shell commands before the agent reads them. | Noisy `git`, test, build and install output. | Only known command formats; file reads and MCP results pass through. |
| **MCP proxies with retrieval** | sqz, mcp_trunc_proxy, context-compress | Between the agent and MCP servers or the shell; keep the full result aside and return a preview. | Very large MCP results. See [MCP tool output compression](https://www.supercompress.dev/mcp-tool-output-compression). | The agent has to know to fetch more. |
| **Wire-level proxies** | Headroom | Rewrites the whole request between the agent and the model provider. | Your own apps and pipelines. | Rewrites the whole request; rewriting history can affect prompt caching. |
| **Built-in compaction** | `/compact` in Claude Code, Codex and OpenCode; `/compress` in Gemini CLI | Summarizes the whole session once it is large. | Long sessions. | Summaries can lose exact details. |
| **Query-aware extraction** | SuperCompress | One bulky result at a time, scored against the current question; keeps original lines. | Logs, diffs, file reads and MCP results where a few lines matter. | Files the agent is about to edit should stay whole. |

## How to measure any of them

1. **Measure what you are billed, per finished task.** Fewer tokens in one request does not always mean a cheaper session. Independent work on coding-agent compression, such as the arXiv paper [An Empirical Cost Attribution of Context-Compression Gateways in Multi-Turn Coding Agents](https://arxiv.org/abs/2609.22114) and the open [tokbench](https://github.com/Entelligentsia/tokbench) harness, makes this point. For the cache-vs-token-count question in full, see [Does context compression lower your bill?](https://www.supercompress.dev/does-context-compression-lower-your-bill). If you are not sure compression fits your workload at all, start with [when to use prompt compression](https://www.supercompress.dev/when-to-use-compression).
2. **Watch prompt caching.** Rewriting earlier turns can break cached prefixes. SuperCompress compresses new bulky results and leaves earlier turns alone, which is the cache-friendly pattern.
3. **Gate on correctness.** Count a session only if the task was done right.
4. **Run your own repo.** Every SuperCompress call reports `original_tokens` and `kept_tokens`, so you can see each call on your own work.

## How SuperCompress works

SuperCompress is hosted, extractive and query-aware. Your agent sends a large block of context (a log, a diff, a file read, an MCP result) together with the question it is working on. Our Neural Keep model scores the lines against that question, keeps the original lines that answer it, and drops the rest. It never rewrites or summarizes, so file paths, error messages, IDs and code come back exactly as they were. The question itself is never compressed.

Every compress call reports `original_tokens` and `kept_tokens`, so you can see what was dropped on your own work instead of trusting a headline number. The `usage_summary` MCP tool shows totals per agent for your account.

## Install

```
npm install -g supercompress-proxy && supercompress setup
```

Setup links your SuperCompress account in the browser, detects the coding agents on the machine and wires each one. Restart the agent so it loads the new MCP server. Then check what is wired up:

```
supercompress doctor
```

`doctor` prints a per-agent health check. `supercompress uninstall` removes only the entries SuperCompress added. Setup backs up each config file before it edits it.

Head-to-head pages: [SuperCompress vs RTK](https://www.supercompress.dev/supercompress-vs-rtk), [SuperCompress vs Headroom](https://www.supercompress.dev/supercompress-vs-headroom), [vs summarization](https://www.supercompress.dev/supercompress-vs-summarization), [vs truncation](https://www.supercompress.dev/supercompress-vs-truncation).

## FAQ

### What is context compression for coding agents?

Reducing what a coding agent sends to the model, usually by shrinking tool output, file reads and MCP results, or by compacting the session.

### What is the best context compression tool for Claude Code?

It depends on where your tokens go. Command filters help with noisy shell output, MCP proxies with huge MCP results, built-in /compact with long sessions, and SuperCompress with bulky output where only a few lines answer the current question. Measure on your own sessions.

### Is SuperCompress a summarizer?

No. It is extractive: it keeps original lines and drops the rest, so error messages, paths and code are unchanged.

### Can I use SuperCompress with RTK or built-in compaction?

Yes. They act at different points and can be combined.

[Get API key](https://www.supercompress.dev/dashboard?signup=1) [Coding agents guide](https://docs.supercompress.dev/coding-agents) [All coding agents](https://www.supercompress.dev/coding-agent-token-usage)
