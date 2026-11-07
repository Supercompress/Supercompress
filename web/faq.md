# SuperCompress FAQ

Canonical HTML: https://www.supercompress.dev/faq

This Markdown file is a noindex convenience extract of the HTML page. Cite the HTML URL.

Short answers to the questions people ask most about SuperCompress, for coding agents and for apps.

- [All coding agents](https://www.supercompress.dev/coding-agent-token-usage)
- [Approaches compared](https://www.supercompress.dev/context-compression-for-coding-agents)
- [MCP token reduction](https://www.supercompress.dev/mcp-token-reduction)
- [MCP tool output compression](https://www.supercompress.dev/mcp-tool-output-compression)
- [Claude Code context limit](https://www.supercompress.dev/claude-code-context-limit)
- [MCP output too large](https://www.supercompress.dev/claude-code-mcp-output-too-large)

**In short:** SuperCompress keeps the original lines that answer your agent's current question and drops the rest. Install with `npm install -g supercompress-proxy && supercompress setup`.

Related: [compare context compression tools](https://www.supercompress.dev/alternatives), including [Headroom alternatives](https://www.supercompress.dev/alternatives/headroom), [Caveman alternatives](https://www.supercompress.dev/alternatives/caveman), and the [Caveman Cloud alternative](https://www.supercompress.dev/alternatives/caveman-cloud).

### What is SuperCompress?

Hosted context compression for coding agents and LLM apps. You send a large context (tool output, logs, diffs, file reads, retrieved documents) together with the current question, and our Neural Keep model keeps the original lines that answer it and drops the rest.

### How do I install SuperCompress for my coding agent?

Run `npm install -g supercompress-proxy && supercompress setup`. Setup links your account in the browser, detects the coding agents on the machine and wires each one. Run `supercompress doctor` to check.

### Which coding agents does it work with?

Claude Code, Cursor, Codex, Hermes Agent, Windsurf, Gemini CLI, Cline, Roo Code, Kilo Code, OpenCode, Zed, Goose, Continue and more. See the [coding agent guides](https://www.supercompress.dev/coding-agent-token-usage).

### Is SuperCompress a summarizer?

No. It is extractive. Every kept line is copied from the original, so error messages, IDs, paths and code come through unchanged.

### What does query-aware mean?

The same log or file can be compressed differently for different questions. SuperCompress scores each block against the current question and keeps what answers it. The question itself is never compressed.

### Does SuperCompress change my agent's login or model?

No. It works through an MCP server, instructions and, for some agents, hooks. Your agent keeps its normal sign-in and talks to its own models.

### Is SuperCompress a proxy?

No. It is not an LLM or a cache. It runs before your model call and returns plain text, so it works with any model provider.

### What MCP tools does it add?

`compress_context` (arguments `context` and `query`), `connect_account` and `usage_summary`.

### How do I see what was removed?

Every compress response reports `original_tokens` and `kept_tokens`, plus kept and dropped blocks. `usage_summary` shows totals per agent.

### Can I call it from my own app?

Yes. Send `POST https://www.supercompress.dev/api/v1/compress` with `context` and `query`, and an API key from the dashboard in the `X-API-Key` header.

### How is it different from RTK or Headroom?

RTK filters known shell commands before the agent reads them. Headroom is a proxy that rewrites requests on the way to the model. SuperCompress works on one bulky result at a time against the current question and keeps original lines. See [approaches compared](https://www.supercompress.dev/context-compression-for-coding-agents).

### When should I not use it?

When the prompt is already small, when a file is about to be edited line by line, or when every byte must pass through unchanged for compliance.

### How do I uninstall it?

Run `supercompress uninstall`. It removes only the entries SuperCompress added.

### Where is pricing?

Current plans and your free allowance are shown in the [dashboard](https://www.supercompress.dev/dashboard?signup=1).

[Get API key](https://www.supercompress.dev/dashboard?signup=1) [Coding agents guide](https://docs.supercompress.dev/coding-agents) [All coding agents](https://www.supercompress.dev/coding-agent-token-usage)
