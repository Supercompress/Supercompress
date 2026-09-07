# SuperCompress API Plugin Integrations

Ready-to-use integration plugins for popular AI frameworks. These let you drop prompt compression into your existing LLM pipeline in minutes — reducing token costs by ~65% with zero code changes to your application logic.

## Coding-agent marketplaces

The [`plugins/supercompress/`](./plugins/supercompress/) directory is a single plugin tree published to the **Claude Code**, **Codex**, and **Cursor** marketplaces (MCP tools + skill, with browser account linking via `connect_account`). See its [README](./plugins/supercompress/README.md) for install commands.

## Available Integrations

| Integration | Language/Framework | Description |
|------------|-------------------|-------------|
| [OpenAI SDK](/integrations/openai_middleware.py) | Python | Transparent middleware — wrap any OpenAI client call |
| [Vercel AI SDK](/integrations/vercel-ai-sdk.ts) | TypeScript / Next.js | Drop-in `wrapLanguageModel` for Vercel AI SDK apps |
| [LangChain](/integrations/langchain_callback.py) | Python | LangChain callback handler that auto-compresses prompts |
| [Anthropic SDK](/integrations/anthropic_middleware.py) | Python | Middleware for Anthropic/Claude API calls |
| [Express Middleware](/integrations/express-middleware.ts) | TypeScript / Node.js | Express/Next.js API route middleware |

## Quick Start

### 1. Get an API Key

```bash
# Sign up at https://supercompress.dev/dashboard
export SUPERCOMPRESS_API_KEY=sc_live_YOUR_KEY
```

### 2. Install

```bash
pip install supercompress  # Python
npm install supercompress-proxy  # Node.js
```

### 3. Use the integration for your framework

See each integration file for usage examples.

## How It Works

All integrations follow the same pattern:

1. **Intercept** the messages/context before they reach the LLM
2. **Compress** using SuperCompress's learned policy (CPU, ~60ms)
3. **Forward** the compressed context to the LLM
4. **Return** the LLM response as normal

No changes to your downstream logic — just wrap your client and save ~65% on token costs.

## Architecture

```
Your App → SuperCompress Plugin → Compressed Context → LLM (OpenAI, Claude, etc.)
                                    ↓
                          65% fewer tokens
                          100% oracle recall
```
