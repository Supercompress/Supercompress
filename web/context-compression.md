# Context compression: the complete guide for LLMs and AI agents

Canonical HTML: https://www.supercompress.dev/context-compression

This Markdown file is a noindex convenience extract of the HTML page. Cite the HTML URL.

# Context compression: the complete guide for LLMs and AI agents

**Context compression** is the practice of shrinking what you send to a large language model (tool output, logs, files, chat history, retrieved documents) so the model sees the information it needs in fewer tokens. Done well, it lowers cost and latency, keeps you under context window limits and reduces context rot, without losing the facts the answer depends on. This guide covers the methods, how query-aware compression differs, how to measure it and which tools do what.

    [All comparisons](https://www.supercompress.dev/comparisons)
    [Headroom alternatives](https://www.supercompress.dev/headroom-alternatives)
    [Context compression guide](https://www.supercompress.dev/context-compression)
    [Tools compared](https://www.supercompress.dev/context-compression-tools-compared)
    [Claude Code tokens](https://www.supercompress.dev/reduce-claude-code-token-usage)
    [FAQ](https://www.supercompress.dev/faq)

## What is context compression?

Context compression reduces the number of tokens in an LLM's input while keeping the information that matters for the task. It is sometimes called prompt compression, token compression, token reduction or context pruning. The input can be anything that lands in the context window: a system prompt, chat history, a 5,000 line log, a diff, an MCP tool result, a web page or a batch of RAG chunks.

## Why context compression matters

- **Cost:** providers bill per input token, and in agent loops input usually dwarfs output because every turn resends history and tool results.
- **Context window limits:** big tool results push sessions into compaction, truncation or errors such as MCP output too large. See [LLM context window too long](https://www.supercompress.dev/llm-context-window-too-long) and [Claude Code MCP output too large](https://www.supercompress.dev/claude-code-mcp-output-too-large).
- **Quality:** long, noisy contexts dilute attention, a failure mode often called [context rot](https://www.supercompress.dev/context-rot).
- **Latency:** fewer input tokens means faster time to first token.

## Context compression methods

### 1. Truncation

Cut the input at a length limit. Cheap and predictable, but it drops whatever falls past the cut, which is often the error at the end of a log. See [compression vs truncation](https://www.supercompress.dev/supercompress-vs-truncation).

### 2. Summarization (abstractive)

Ask a model to rewrite the context shorter. Good for narrative history, risky for code, IDs, numbers and error strings because rewritten text can drift from the source. See [compression vs summarization](https://www.supercompress.dev/supercompress-vs-summarization) and [extractive vs abstractive](https://www.supercompress.dev/extractive-vs-abstractive-context-compression).

### 3. Token pruning

A small model scores tokens and deletes low-information ones (LLMLingua, LLMLingua-2, Selective Context, hosted APIs such as Bear). High ratios are possible, but tokens disappear inside lines, which can break code and identifiers. See [how prompt compression works](https://www.supercompress.dev/how-prompt-compression-works).

### 4. Extractive, line-level selection

Keep or drop whole original lines or spans. What is kept is verbatim, so paths, stack traces and code stay exact. See [verbatim lines vs token pruning](https://www.supercompress.dev/verbatim-lines-vs-token-pruning).

### 5. Rule-based filters

Command-specific rules strip known noise from shell output (rtk is the best-known example). Fast and local, but blind to what you are asking.

### 6. Retrieval instead of compression

Index the codebase or corpus and fetch only relevant chunks or symbols (claude-context, jCodeMunch). This sends less in the first place but does not shrink a big result once it has been produced.

### 7. Soft or latent compression

Research methods such as gist tokens, AutoCompressors and KV cache compression shrink internal representations. They need model access and are not something you can put in front of a hosted API.

### 8. Session compaction

Coding agents summarize or clear history when the window fills (/compact, /clear). Useful, but lossy. See [/compact vs /clear vs compression](https://www.supercompress.dev/claude-code-compact-vs-clear-vs-compression).

## Query-aware context compression

Most methods decide what to keep from the content alone. Query-aware compression also looks at the question being asked right now, so the same 2,000 line log keeps different lines depending on whether you asked why the build failed or which version was installed. LongLLMLingua and some hosted APIs are question-aware at the token level. SuperCompress is query-aware at the line level: the hosted Neural Keep model keeps the original lines that answer the current question, verbatim, and drops the rest.

## Context compression for coding agents

Coding agents (Claude Code, Cursor, Codex, Windsurf, Cline, Gemini CLI, OpenCode and others) spend most tokens on tool results: file reads, grep, test output, build logs and MCP responses. Agent context pruning works best at that boundary, before the result lands in history and is resent every turn. Guides: [reduce Claude Code token usage](https://www.supercompress.dev/reduce-claude-code-token-usage), [Cursor](https://www.supercompress.dev/reduce-cursor-token-usage), [Codex](https://www.supercompress.dev/reduce-codex-token-usage), [MCP tool output compression](https://www.supercompress.dev/mcp-tool-output-compression), [approaches for coding agents](https://www.supercompress.dev/context-compression-for-coding-agents).

## Context compression for RAG

Retrieved chunks are usually only partly relevant. Compressing them against the user question before generation cuts tokens and can reduce distraction. Keep source lines verbatim when answers must be quotable or cited.

## How to measure context compression

- **Tokens in vs tokens kept** on your real traffic (the SuperCompress API returns `original_tokens` and `kept_tokens` on every call).
- **Task success** with and without compression on the same tasks.
- **Cost per finished task** on your provider bill, since caching, retries and extra turns change the picture. See [does context compression lower your bill?](https://www.supercompress.dev/does-context-compression-lower-your-bill)

Our published methodology and limitations are on the [benchmarks page](https://www.supercompress.dev/benchmarks).

## Context compression tools compared

| Tool | Best if | What it optimizes | Runs | Licence |
| --- | --- | --- | --- | --- |
| SuperCompress | your agent keeps pulling big tool results, logs or retrieved docs and only a few lines matter for the question at hand, and you want those lines kept verbatim. | Input context (tool output, logs, files, MCP results, RAG) | Hosted API, plus an MCP tool and hooks for coding agents | Hosted service |
| Headroom | you want a broad, local, open-source compression layer and are happy to run a Python runtime and proxy. | Input context and history | Locally (library, proxy, MCP, agent wrap) | Apache-2.0 |
| LLMLingua | you run your own Python pipeline, can host a small model next to it, and want a well-cited research method. | Prompts and retrieved context | Locally, in your Python pipeline | MIT |
| Compresr | you want a hosted compression API for RAG and Q&A pipelines and are fine with token-level output. | Prompts, documents, RAG context | Hosted API (on-premises option) | Closed hosted service |
| Bear (The Token Company) | you want a one-line wrapper around an OpenAI or Anthropic client that deletes low-signal tokens. | Prompts, chat history, search results | Hosted API (enterprise VPC option) | Closed hosted service |
| rtk | your pain is noisy shell command output and you want a free, local, rule-based filter. | Shell command output | Locally (CLI proxy and hook) | Open source |
| jCodeMunch | most of your waste is the agent reading whole files to find one function. | Source code reads | Locally, as an MCP server | Custom dual-use licence |
| claude-context | retrieval quality is the goal and you already run, or are happy to run, vector infrastructure. | What code gets read | MCP server backed by Milvus or Zilliz Cloud | Open source (needs vector DB and embeddings) |
| Caveman | your main goal is shorter model replies and you do not mind the terse register. | Model output (replies) | Locally, as an agent skill or prompt | Open source |

Full write-ups: [all comparisons](https://www.supercompress.dev/comparisons), [Headroom alternatives](https://www.supercompress.dev/headroom-alternatives), [LLMLingua alternatives](https://www.supercompress.dev/alternatives/llmlingua), [Compresr alternatives](https://www.supercompress.dev/alternatives/compresr), [tools compared](https://www.supercompress.dev/context-compression-tools-compared).

## Try query-aware compression

Coding agents: one command installs an MCP tool for each detected agent, plus hooks where supported.

```
npm install -g supercompress-proxy && supercompress setup
```

Apps: call `POST /api/v1/compress` with your context and question. See the [API reference](https://docs.supercompress.dev/api-reference).

## FAQ

### What is context compression?

Context compression shrinks the input sent to an LLM, such as tool output, logs, files, chat history or retrieved documents, so the model gets the information it needs in fewer tokens.

### What is the difference between context compression and prompt compression?

They overlap. Prompt compression usually refers to shrinking a prompt, often by token pruning. Context compression is broader and covers anything in the context window, including tool results and history in agent loops.

### What is query-aware context compression?

Compression that uses the current question to decide what to keep, so the same input keeps different content depending on what is being asked.

### Does context compression hurt accuracy?

It can if it drops what the answer needs or rewrites facts. Extractive, query-aware methods that keep original lines verbatim reduce that risk. Always test task success with and without compression.

### How do I reduce Claude Code, Cursor or Codex token usage?

Check what fills the window, keep instruction files short, disable unused MCP servers, start fresh sessions per task, and compress bulky tool output against the current question, for example with npm install -g supercompress-proxy && supercompress setup.

### How do I fix MCP output too large errors?

Compress or filter the tool result before it reaches the model, or ask the tool for a narrower result. Query-aware compression keeps the lines relevant to the question.

### Is summarization a form of context compression?

Yes, abstractive compression. It is useful for narrative history but can alter code, numbers and identifiers, so extractive methods are safer for technical content.

[Get API key](https://www.supercompress.dev/dashboard?signup=1)
      [Coding agents guide](https://docs.supercompress.dev/coding-agents)
      [All comparisons](https://www.supercompress.dev/comparisons)
