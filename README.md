<p align="center">
  <a href="https://www.supercompress.dev">
    <img src="https://www.supercompress.dev/assets/img/og-share-light.png" alt="SuperCompress — cut LLM context waste" width="840" />
  </a>
</p>

<h1 align="center">SuperCompress</h1>

<p align="center">
  <strong>Query-aware context compression for LLMs and coding agents.</strong><br />
  Keep the evidence. Drop the filler. Pay for fewer input tokens.
</p>

<p align="center">
  <a href="https://www.supercompress.dev">Website</a> ·
  <a href="https://www.supercompress.dev/playground">Playground</a> ·
  <a href="https://www.supercompress.dev/benchmarks">Benchmarks</a> ·
  <a href="https://docs.supercompress.dev">Docs</a> ·
  <a href="https://docs.supercompress.dev/coding-agents">Coding agents</a> ·
  <a href="./CHANGELOG.md">Changelog</a> ·
  <a href="./ROADMAP.md">Roadmap</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://www.supercompress.dev/supercompress-vs-headroom">vs Headroom</a> ·
  <a href="https://www.supercompress.dev/supercompress-vs-rtk">vs RTK</a> ·
  <a href="https://www.supercompress.dev/supercompress-vs-llmlingua">vs LLMLingua</a>
</p>

<p align="center">
  <a href="https://pypi.org/project/supercompress/"><img src="https://img.shields.io/pypi/v/supercompress?style=flat&logo=python&logoColor=white&label=PyPI" alt="PyPI" /></a>
  <a href="https://www.npmjs.com/package/supercompress-proxy"><img src="https://img.shields.io/npm/v/supercompress-proxy?style=flat&logo=npm&logoColor=white&label=npm" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3da639?style=flat" alt="MIT License" /></a>
  <a href="https://github.com/Supercompress/Supercompress"><img src="https://img.shields.io/badge/GitHub-Supercompress-181717?style=flat&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="https://www.supercompress.dev/dashboard?signup=1"><img src="https://img.shields.io/badge/Sponsor-EA4AAA?style=flat&logo=githubsponsors&logoColor=white" alt="Sponsor SuperCompress" /></a>
</p>

---

## Why it exists

Every LLM call ships a pile of context: RAG chunks, chat history, tool dumps, logs, JSON. Most of it is irrelevant to the *current* question — but the model still reads it, and you still pay for it.

| Usual “fix” | What actually happens |
|---|---|
| **Truncate** | Deletes the middle. The answer is often in the middle. |
| **Summarize** | Rewrites evidence. IDs, stack traces, and exact errors get soft. |
| **Hope** | Ship the full dump. Watch the bill climb. |

**SuperCompress** compresses context **against the query**. It keeps answer-critical lines in their original wording and drops the rest — typically **~65% fewer input tokens**.

---

## Product

SuperCompress is a compression layer in front of inference:

1. Takes a long **context** + the current **query**
2. Segments and scores blocks by relevance to that query
3. Keeps entities, errors, definitions, nearby dependencies
4. Returns a smaller prompt + token stats

The **query is never compressed** — only the surrounding context.

### Two products, one engine

| | **Coding-agent plugin** | **API / Python** |
|---|---|---|
| **For** | Cursor, Claude Code, Codex, and 40+ agents | Apps, RAG, agents, backends |
| **Install** | `npm i -g supercompress-proxy && npx supercompress setup` | `pip install supercompress` |
| **What you get** | MCP `compress_context` on big dumps | Compress before every model call |
| **Login** | Keep your normal agent login | API key from the [dashboard](https://www.supercompress.dev/dashboard) |

Docs: [coding agents](https://docs.supercompress.dev/coding-agents) · [API quickstart](https://docs.supercompress.dev/quickstart)

New to the coding-agent plugin? Start with the [first 5 minutes checklist](https://docs.supercompress.dev/coding-agents#first-five-minutes).

### Repo map

| Path | What |
|------|------|
| `packages/proxy` | Coding-agent plugin (npm) |
| `api/` | Hosted API + billing |
| `web/` | Site + docs HTML |
| `supercompress/` | Python package |
| `docs/REPO_LAYOUT.md` | What belongs in OSS vs private |

Private marketing, outreach, and model training stay **out** of this repo (see `.gitignore` + `docs/REPO_LAYOUT.md`).

---

## Benchmarks & stats

We measure **whether the answer survives**, not vibes.

<p align="center">
  <img src="https://www.supercompress.dev/assets/img/chart-oracle-recall.svg" alt="Oracle recall at fixed 35% budget: SuperCompress 100% vs truncation 24.8%" width="720" />
</p>

**Same keep-budget (35% of tokens kept). Who still has the answer?**

| Method | Answer-critical kept |
|---|---:|
| FIFO / truncation | **24.8%** |
| Summarization | **60.5%** |
| H2O | **97.9%** |
| **SuperCompress** | **100%** |

### Headline numbers

| Metric | Result | Notes |
|---|---:|---|
| **Oracle recall** (fixed budget) | **100%** | Public 8-seed suite vs ~25% truncation |
| **Compiler-mode savings** | **~62%** avg | Maximize cut while keeping critical lines |
| **Real / OOD answer retention** | **100%** (66/66) | LongBench + hard haystacks |
| **Mean token cut** (real suite) | **~67%** | Token-weighted ~74% |
| **Important lines kept** (compiler) | **100%** | Across bundled long-context presets |

Full methodology: **[supercompress.dev/benchmarks](https://www.supercompress.dev/benchmarks)**

---

## Try it

### Coding agents (recommended)

```bash
npm install -g supercompress-proxy
npx supercompress setup
```

Links your account, detects agents, installs MCP. Docs: [coding agents](https://docs.supercompress.dev/coding-agents)

### Python / HTTP

```bash
pip install supercompress
export SUPERCOMPRESS_API_KEY=sc_live_YOUR_KEY
```

```python
from supercompress.client import SuperCompress

sc = SuperCompress()
result = sc.compress(
    context=long_context,
    query="What failed and how do we fix it?",
)
print(f"{result.original_tokens} → {result.kept_tokens} tokens")
print(result.compressed_text)
```

```bash
curl -X POST https://www.supercompress.dev/api/v1/compress \
  -H "X-API-Key: $SUPERCOMPRESS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"context":"...","query":"What failed?"}'
```

Or paste a dump into the **[playground](https://www.supercompress.dev/playground)** — no integration required.

---

## How it compares

| | Truncate | Summarize | **SuperCompress** |
|---|:---:|:---:|:---:|
| Cuts tokens | ✓ | ✓ | ✓ |
| Uses the query | ✗ | weak | ✓ |
| Keeps original evidence | sometimes | ✗ | ✓ |
| Auditable kept lines | partial | ✗ | ✓ |

More: [vs truncation](https://www.supercompress.dev/supercompress-vs-truncation) · [vs summarization](https://www.supercompress.dev/supercompress-vs-summarization) · [vs alternatives](https://www.supercompress.dev/supercompress-vs-alternatives)

---

<p align="center">
  <a href="https://www.supercompress.dev/playground"><img src="https://img.shields.io/badge/Try_the_playground-2563EB?style=for-the-badge" alt="Playground" /></a>
  &nbsp;
  <a href="https://www.supercompress.dev/dashboard"><img src="https://img.shields.io/badge/Get_an_API_key-111827?style=for-the-badge" alt="Dashboard" /></a>
  &nbsp;
  <a href="https://docs.supercompress.dev/coding-agents"><img src="https://img.shields.io/badge/Install_for_agents-059669?style=for-the-badge" alt="Agents" /></a>
</p>

<p align="center">
  <sub>
    <a href="https://www.supercompress.dev">supercompress.dev</a> ·
    <a href="./LICENSE">MIT License</a> ·
    <a href="https://www.supercompress.dev/dashboard?signup=1">Sponsor</a> ·
    built by <a href="https://github.com/arjunkshah12345-hash">Arjun Shah</a>
  </sub>
</p>
