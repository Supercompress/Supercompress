# Reduce coding agent token usage

Canonical HTML: https://www.supercompress.dev/coding-agent-token-usage

This Markdown file is a noindex convenience extract of the HTML page. Cite the HTML URL.

# Reduce coding agent token usage

Coding agents spend most of their tokens rereading tool output: file reads, shell logs, search hits and MCP results. Pick your agent below for where its tokens go, the habits that help, and what `supercompress setup` adds to it.

    [Approaches compared](https://www.supercompress.dev/context-compression-for-coding-agents)
    [MCP token reduction](https://www.supercompress.dev/mcp-token-reduction)
    [MCP tool output compression](https://www.supercompress.dev/mcp-tool-output-compression)
    [Claude Code context limit](https://www.supercompress.dev/claude-code-context-limit)
    [MCP output too large](https://www.supercompress.dev/claude-code-mcp-output-too-large)
    [FAQ](https://www.supercompress.dev/faq)

      **In short:** one install covers every detected agent: `npm install -g supercompress-proxy && supercompress setup`, then `supercompress doctor`. The full harness list is in the [coding agents guide](https://docs.supercompress.dev/coding-agents).

Related: [compare context compression tools](https://www.supercompress.dev/alternatives) for agents, including [Headroom alternatives](https://www.supercompress.dev/alternatives/headroom), [Caveman alternatives](https://www.supercompress.dev/alternatives/caveman), and the [Caveman Cloud alternative](https://www.supercompress.dev/alternatives/caveman-cloud).

## By coding agent

| Agent | What setup adds |
| --- | --- |
| [**Claude Code**](https://www.supercompress.dev/reduce-claude-code-token-usage) | MCP server, CLAUDE.md instructions and hooks, or the Claude Code plugin. |
| [**Cursor**](https://www.supercompress.dev/reduce-cursor-token-usage) | MCP server, an always-on rule and hooks. |
| [**Codex**](https://www.supercompress.dev/reduce-codex-token-usage) | MCP server, AGENTS.md instructions and hooks. Works with a ChatGPT sign-in. |
| [**Hermes Agent**](https://www.supercompress.dev/reduce-hermes-agent-token-usage) | MCP server, shell hooks, a plugin and Hermes compression settings. |
| [**Windsurf**](https://www.supercompress.dev/reduce-windsurf-token-usage) | MCP server for Cascade. |
| [**Gemini CLI**](https://www.supercompress.dev/reduce-gemini-cli-token-usage) | MCP server in settings.json. |
| [**Cline, Roo Code and Kilo Code**](https://www.supercompress.dev/reduce-cline-token-usage) | MCP server in each extension's settings. |
| [**OpenCode**](https://www.supercompress.dev/reduce-opencode-token-usage) | MCP server and AGENTS.md instructions. |
| [**Goose**](https://www.supercompress.dev/reduce-goose-token-usage) | MCP server in config.yaml and AGENTS.md instructions. No SuperCompress hooks. |
| [**OpenClaw**](https://www.supercompress.dev/reduce-openclaw-token-usage) | MCP server, bootstrap and compact hooks, plugin, skill and AGENTS.md. The plugin writes a session digest and prepends it on the next prompt. It does not replace tool output. |
| [**Grok Build**](https://www.supercompress.dev/reduce-grok-build-token-usage) | MCP server in config.toml, hooks, AGENTS.md instructions and a skill. A PostToolUse hook replaces the model's copy of a large tool result with a compressed digest. |

Setup also detects Zed, Continue, Amp, Crush, GitHub Copilot in VS Code, Claude Desktop, [Grok Build](https://www.supercompress.dev/reduce-grok-build-token-usage) and more. Run `supercompress doctor` to see what it found on your machine.

## Guides

- [Context compression for coding agents: approaches compared](https://www.supercompress.dev/context-compression-for-coding-agents)
- [MCP token reduction](https://www.supercompress.dev/mcp-token-reduction)
- [MCP tool output compression](https://www.supercompress.dev/mcp-tool-output-compression)
- [Claude Code context limit](https://www.supercompress.dev/claude-code-context-limit)
- [Claude Code MCP output too large](https://www.supercompress.dev/claude-code-mcp-output-too-large)
- [SuperCompress FAQ](https://www.supercompress.dev/faq)

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

## FAQ

### Which coding agents does SuperCompress support?

Claude Code, Cursor, Codex, Hermes Agent, Windsurf, Gemini CLI, Cline, Roo Code, Kilo Code, OpenCode, Zed, Goose, OpenClaw, Grok Build, Continue and more. supercompress setup detects them and supercompress doctor lists what it found.

### Do I need to install SuperCompress separately for each agent?

No. One supercompress setup wires every detected agent. Run supercompress plugin after you install a new agent.

[Get API key](https://www.supercompress.dev/dashboard?signup=1)
      [Coding agents guide](https://docs.supercompress.dev/coding-agents)
      [All coding agents](https://www.supercompress.dev/coding-agent-token-usage)
