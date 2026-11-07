# Claude Code MCP tool output too large: what to do

Canonical HTML: https://www.supercompress.dev/claude-code-mcp-output-too-large

This Markdown file is a noindex convenience extract of the HTML page. Cite the HTML URL.

# Claude Code MCP tool output too large: what to do

Claude Code warns when an MCP tool returns a very large result and caps how much of it is passed to the model. Raising the cap makes the warning go away but puts the whole result in context. Here are the options, from the setting to fixes that shrink the result itself.

    [All coding agents](https://www.supercompress.dev/coding-agent-token-usage)
    [Approaches compared](https://www.supercompress.dev/context-compression-for-coding-agents)
    [MCP token reduction](https://www.supercompress.dev/mcp-token-reduction)
    [MCP tool output compression](https://www.supercompress.dev/mcp-tool-output-compression)
    [Claude Code context limit](https://www.supercompress.dev/claude-code-context-limit)
    [FAQ](https://www.supercompress.dev/faq)

      **In short:** raise `MAX_MCP_OUTPUT_TOKENS` only when the whole result really matters. Otherwise ask the server for less (filters, fields, pages), or compress the result against the current question with SuperCompress so Claude keeps the lines that answer it.

## Why it happens

MCP servers often return everything they have: a whole issue thread, a full page of search results, a large JSON document or a complete log. Claude Code shows a warning for large MCP results and limits how many tokens of a result it accepts. The `MAX_MCP_OUTPUT_TOKENS` environment variable changes that limit.

## Your options

| Option | How | Trade-off |
| --- | --- | --- |
| **Raise the limit** | `MAX_MCP_OUTPUT_TOKENS=50000 claude` | Raises Claude Code's MCP token budget. Separately, results over ~50,000 characters are still saved to a file and the agent gets the path, so raising the token limit does not put every large result into context. |
| **Ask for less** | Use the server's filters, field selection, page size or search parameters. | Only works when the server supports it and you know what to ask for. |
| **Truncate** | A proxy or wrapper that cuts results at a fixed size. | Blind: the line you need may be past the cut. |
| **Compress against the question** | SuperCompress `compress_context` with the bulky result as `context` and your ask as `query`. | Keeps the original lines that answer the question and drops the rest; reports `original_tokens` and `kept_tokens`. |

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

For how this compares with schema trimming, code mode and other MCP approaches, see [MCP token reduction](https://www.supercompress.dev/mcp-token-reduction) and [MCP tool output compression](https://www.supercompress.dev/mcp-tool-output-compression).

## FAQ

### What does MAX_MCP_OUTPUT_TOKENS do?

It sets how many tokens of an MCP tool result Claude Code will accept. Raising it lets larger results through, and those results stay in the session for later turns.

### Should I just raise MAX_MCP_OUTPUT_TOKENS?

Only when the agent really needs the whole result in context. Claude Code also has a separate ~50,000-character threshold: above that, the result is written to a file and the agent receives the path, so a higher token limit alone will not inline every large MCP payload. If the agent needs a few lines, filter at the server or compress the result against the question.

### Does SuperCompress change the MCP server I am calling?

No. It works on the result text. Your MCP servers keep working as before.

[Get API key](https://www.supercompress.dev/dashboard?signup=1)
      [Coding agents guide](https://docs.supercompress.dev/coding-agents)
      [All coding agents](https://www.supercompress.dev/coding-agent-token-usage)
