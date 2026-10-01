<p align="center">
  <a href="https://www.supercompress.dev">
    <img src="https://www.supercompress.dev/assets/img/og-share-light.png" alt="SuperCompress — cut LLM context waste" width="840" />
  </a>
</p>

<h1 align="center">SuperCompress v2</h1>

<p align="center">
  <strong>Query-aware context compression for AI applications and coding agents.</strong><br />
  Give your AI less. Keep what matters.
</p>

<p align="center">
  <strong>~400M Neural Keep</strong> on the hosted API · coding-agent plugin via MCP<br />
  <a href="https://huggingface.co/arjunkshah21/sc-keep-crossencoder-v4-large">Open weights (MIT) on Hugging Face</a>
</p>

<p align="center">
  <strong>64% less context</strong> · <strong>24/24</strong> coding benchmark passes · up to <strong>96.6%</strong> reduction at ≥99% evidence retention<br />
  <em>(B5 coding-agent suite · evidence containment metric — not downstream LLM completion)</em>
</p>

<p align="center">
  <a href="https://www.supercompress.dev/dashboard?signup=1">Get API key</a> ·
  <a href="https://www.supercompress.dev/arena">Arena</a> ·
  <a href="https://www.npmjs.com/package/supercompress-proxy">Install</a> ·
  <a href="https://www.supercompress.dev/benchmarks">Benchmarks</a> ·
  <a href="https://docs.supercompress.dev">Docs</a>
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

**SuperCompress v2** compresses context **against the query**. It keeps answer-critical lines in their original wording and drops the rest — on our coding-agent benchmark (B5), **64.1% mean context reduction** with **24/24 evidence-retention passes**.

---

## Product

SuperCompress is a compression layer in front of inference:

1. Takes a long **context** + the current **query**
2. Segments and scores blocks by relevance to that query
3. Keeps entities, errors, definitions, nearby dependencies
4. Returns a smaller prompt + token stats

The **query is never compressed** — only the surrounding context.

### Two paths

| | **Neural v2 (recommended)** | **Compiler (fast/local)** |
|---|---|---|
| **Engine** | ~400M query-aware cross-encoder | Lightweight local policy |
| **Runtime** | Hosted GPU | CPU · millisecond-class |
| **Best for** | Highest-quality keep on agent dumps | Local preprocessing / speed |
| **Benchmarks** | [Launch / B5](https://www.supercompress.dev/benchmarks) | [Legacy section](https://www.supercompress.dev/benchmarks#legacy-compiler) |

### Two products

| | **Coding-agent plugin** | **API / Python** |
|---|---|---|
| **For** | Cursor, Claude Code, Codex, and 40+ agents | Apps, RAG, agents, backends |
| **Install** | `npm i -g supercompress-proxy && npx supercompress setup` | `pip install supercompress` |
| **What you get** | MCP `compress_context` on big dumps | Compress before every model call |
| **Login** | Keep your normal agent login | API key from the [dashboard](https://www.supercompress.dev/dashboard) |

Docs: [coding agents (first 5 minutes checklist)](https://docs.supercompress.dev/coding-agents#quickstart) · [API quickstart](https://docs.supercompress.dev/quickstart)

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

We measure **whether required evidence survives** (containment), not downstream LLM completion.

### Neural v2 launch (hosted ~400M) — B5 coding-agent suite

| Metric | Result |
|---|---:|
| **Mean context cut** | **64.1%** |
| **Evidence passes** | **24 / 24** |
| **Tokens** | **16,647 → 5,148** |
| **Max cut @ ≥99% retention** | **96.6%** |
| **B5 latency p50** | **~5.8 s** (hosted GPU) |
| **Public cases (full suite)** | **390** |
| **Downstream LLM eval** | **Not yet run** |

Aggregate mean cut across all 390 cases is ~3.6% — the engine often refuses to over-cut dense needle/QA slices. The 64.1% figure is the coding-agent suite where dumps are noisy.

Raw JSON: [launch-benchmark.json](https://www.supercompress.dev/assets/data/launch-benchmark.json) · writeup: [benchmarks](https://www.supercompress.dev/benchmarks)

### Legacy compiler (separate product)

CPU / millisecond-class local path. Older held-out compiler numbers (≈58–66% cut, 99.4% gold containment) live under [Legacy/compiler on /benchmarks](https://www.supercompress.dev/benchmarks#legacy-compiler). **Do not mix with Neural v2.**

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

Or paste a dump into the **[Arena](https://www.supercompress.dev/arena)** — no integration required.

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
  <a href="https://www.supercompress.dev/arena"><img src="https://img.shields.io/badge/Try_the_Arena-2563EB?style=for-the-badge" alt="Arena" /></a>
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
