#!/usr/bin/env python3
"""Build the "best X alternatives" roundup pages under web/alternatives/.

Each page reuses the head/header/footer of web/alternatives/caveman-cloud.html so it stays on the
site's article chrome, and adds TechArticle + ItemList + FAQPage + BreadcrumbList JSON-LD.
Run: python3 scripts/build_best_alternatives.py
"""
from __future__ import annotations

import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SITE = "https://www.supercompress.dev"
TEMPLATE = (WEB / "alternatives" / "caveman-cloud.html").read_text()
PUBLISHED = "2026-10-21"

HEADER = TEMPLATE[TEMPLATE.index('<header class="df-header">'):TEMPLATE.index('<main class="seo-page"')]
FOOTER = TEMPLATE[TEMPLATE.index('<footer class="df-footer">'):]
INSTALL = "npm install -g supercompress-proxy &amp;&amp; supercompress setup"

FAIR = (
    "Every tool here publishes its own headline numbers, and independent studies have found that fewer tokens "
    "do not always mean a smaller bill once prompt caching, retries and extra agent turns are counted (see "
    '<a href="https://arxiv.org/abs/2607.12161" rel="noopener" target="_blank">PointFive\'s end-to-end study</a> and '
    '<a href="https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/" rel="noopener" target="_blank">JetBrains\' rtk trial</a>; '
    "neither tested SuperCompress). Run the same tasks with and without a tool, check that the tasks still succeed, "
    "and compare your provider bill per finished task. That test matters more than any list, including this one."
)
DISCLOSURE = (
    "<p class=\"seo-note\"><strong>Disclosure:</strong> SuperCompress is our product, so we are not neutral. "
    "We describe every other tool from its own documentation and public reporting, link the sources, and say where "
    "another tool is the better fit. Plans and prices change; check each vendor before you decide.</p>"
)


def tool_section(t: dict) -> str:
    rows = "".join(f"<li><strong>{k}:</strong> {v}</li>" for k, v in t["facts"])
    return (
        f'<h3 id="{t["id"]}">{t["n"]}. ' + (t["name"] if t["url"].startswith(SITE) else f'<a href="{t["url"]}" rel="noopener" target="_blank">{t["name"]}</a>') + '</h3>\n'
        f'    <p>{t["body"]}</p>\n'
        f"    <ul>{rows}</ul>\n"
    )


def page(p: dict) -> str:
    url = f'{SITE}/alternatives/{p["slug"]}'
    desc = p["description"]
    ld_article = {
        "@context": "https://schema.org", "@type": "TechArticle", "headline": p["h1"], "description": desc,
        "datePublished": PUBLISHED, "dateModified": PUBLISHED,
        "author": {"@type": "Person", "name": "Arjun Shah"},
        "publisher": {"@type": "Organization", "name": "SuperCompress", "url": f"{SITE}/"},
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
    }
    ld_list = {
        "@context": "https://schema.org", "@type": "ItemList", "name": p["h1"],
        "itemListOrder": "https://schema.org/ItemListOrderAscending",
        "numberOfItems": len(p["tools"]),
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": t["name"], "url": t["url"]}
            for i, t in enumerate(p["tools"])
        ],
    }
    ld_faq = {
        "@context": "https://schema.org", "@type": "FAQPage",
        "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": re.sub(r"<[^>]+>", "", a)}}
            for q, a in p["faq"]
        ],
    }
    ld_crumbs = {
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE}/"},
            {"@type": "ListItem", "position": 2, "name": "Alternatives", "item": f"{SITE}/alternatives"},
            {"@type": "ListItem", "position": 3, "name": p["crumb"], "item": url},
        ],
    }
    ld = "\n".join(
        f'  <script type="application/ld+json">\n{json.dumps(x, indent=2)}\n  </script>'
        for x in (ld_article, ld_list, ld_faq, ld_crumbs)
    )
    table_rows = "".join(
        "<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in p["table"]["rows"]
    )
    table_head = "".join(f"<th>{h}</th>" for h in p["table"]["head"])
    faq_html = "".join(f"<h3>{html.escape(q)}</h3>\n    <p>{a}</p>\n    " for q, a in p["faq"])
    related = "".join(f'<a href="{h}">{t}</a>' for h, t in p["related"])
    tools_html = "".join(tool_section(t) for t in p["tools"])
    e = html.escape
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>{e(p["title"])}</title>
  <meta name="description" content="{e(desc)}" />
  <meta name="keywords" content="{e(p["keywords"])}" />
  <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large" />
  <meta property="og:title" content="{e(p["h1"])}" />
  <meta property="og:description" content="{e(desc)}" />
  <meta property="og:image" content="{SITE}/assets/img/og-share-light.png" />
  <meta property="og:url" content="{url}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="SuperCompress" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{e(p["h1"])}" />
  <meta name="twitter:description" content="{e(desc)}" />
  <meta name="twitter:image" content="{SITE}/assets/img/og-share-light.png" />
  <link rel="canonical" href="{url}" />
  <meta property="article:published_time" content="{PUBLISHED}T00:00:00-07:00" />
  <meta property="article:modified_time" content="{PUBLISHED}" />
  <link rel="icon" href="/favicon-chevron.ico?v=3" sizes="any" />
  <link rel="icon" href="/assets/img/favicon-chevron.svg?v=3" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/assets/img/icon-chevron-192.png?v=3" />
  <link rel="stylesheet" href="/assets/css/supercompress.css?v=115" />
  <link rel="stylesheet" href="/assets/css/landing-chrome.css?v=14" />
  <link rel="stylesheet" href="/assets/css/seo-cluster.css?v=3" />
  <link rel="stylesheet" href="/assets/css/article-page.css?v=3" />
{ld}
  <link rel="stylesheet" href="/assets/css/blog-editorial.css?v=1" />
</head>
<body data-editorial="article">
{HEADER}<main class="seo-page" data-article-content>
  <p class="seo-kicker">Alternatives · Updated {PUBLISHED}</p>
  <h1>{p["h1"]}</h1>
  <p class="seo-lead">{p["lead"]}</p>
  <nav class="seo-cluster" aria-label="Related">{related}</nav>
  <div class="article-prose">
    <h2 id="short-answer">The short answer</h2>
    <p>{p["answer"]}</p>
    <h2 id="what-it-is">{p["about_h"]}</h2>
    <p>{p["about"]}</p>
    <h2 id="how-we-picked">How we picked</h2>
    <p>{p["criteria"]}</p>
    <h2 id="the-list">The alternatives</h2>
    {tools_html}
    <h2 id="comparison">Side by side</h2>
    <table>
      <thead><tr>{table_head}</tr></thead>
      <tbody>{table_rows}</tbody>
    </table>
    <h2 id="measure">How to pick fairly</h2>
    <p>{FAIR}</p>
    {DISCLOSURE}
    <h2 id="install">Try SuperCompress</h2>
    <p>One command installs the CLI and wires the hosted compressor into every coding agent it finds (Claude Code, Cursor, Codex, Windsurf, Cline, Gemini CLI, OpenCode and more). <code>supercompress doctor</code> then shows a health check per agent.</p>
    <pre><code>{INSTALL}</code></pre>
    <p>Building your own app instead? Call the <a href="https://docs.supercompress.dev/api-reference">hosted API</a> with a key from the <a href="/dashboard?signup=1">dashboard</a>.</p>
    <h2 id="faq">FAQ</h2>
    {faq_html}<p class="seo-cta-row">
      <a class="df-nav-cta" href="/dashboard?signup=1">Get API key</a>
      <a href="https://docs.supercompress.dev/coding-agents">Coding agents guide</a>
      <a href="/alternatives">All alternatives</a>
    </p>
  </div>
</main>
{FOOTER}"""


SC = {
    "id": "supercompress", "name": "SuperCompress", "url": f"{SITE}/",
    "facts": [
        ("Best for", "cutting the input tokens an agent or app sends: tool output, file reads, logs, MCP results, retrieved docs"),
        ("How it works", "a hosted, query-aware model keeps the original lines that answer the current question, word for word, and drops the rest"),
        ("Runs", "hosted API (<code>POST /api/v1/compress</code>) plus an MCP tool and hooks for coding agents"),
        ("Price", '5M free tokens a month, then $0.10 per million, per <a href="/dashboard?signup=1">the site</a>'),
    ],
}
CAVEMAN = {
    "id": "caveman", "name": "Caveman (open-source skill)", "url": "https://github.com/JuliusBrussee/caveman",
    "facts": [
        ("Best for", "shorter agent replies, at no cost"),
        ("How it works", "a skill that makes the agent answer in terse, caveman-style prose, plus local shrinking of some tool output"),
        ("Watch out for", 'an <a href="https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/" rel="noopener" target="_blank">independent JetBrains A/B test</a> measured an 8.5% output saving against the advertised 65%, and the skill itself adds input tokens every turn'),
    ],
}
HEADROOM = {
    "id": "headroom", "name": "Headroom", "url": "https://github.com/chopratejas/headroom",
    "facts": [
        ("Best for", "teams that want an open-source compression layer they run themselves"),
        ("How it works", "content-type compressors for JSON, logs, code, search results and history, with the originals kept so the model can ask for them back"),
        ("Runs", "locally, as a Python or TypeScript library, a proxy, an MCP server or an agent wrapper (<code>headroom wrap claude</code>)"),
        ("Licence", "Apache 2.0"),
    ],
}
RTK = {
    "id": "rtk", "name": "RTK (Rust Token Killer)", "url": "https://github.com/rtk-ai/rtk",
    "facts": [
        ("Best for", "noisy shell commands such as <code>git status</code>, test runs and builds"),
        ("How it works", "a hook rewrites Bash commands to run through command-specific output filters"),
        ("Watch out for", "it only sees Bash calls, so built-in Read, Grep and Glob tools are not filtered; its 60–90% figures are the project's own estimates"),
    ],
}
LLMLINGUA = {
    "id": "llmlingua-2", "name": "LLMLingua-2", "url": "https://www.microsoft.com/en-us/research/project/llmlingua/",
    "facts": [
        ("Best for", "research and self-hosted pipelines over natural-language prompts"),
        ("How it works", "a small token-classification model, distilled from GPT-4, deletes low-value tokens"),
        ("Watch out for", "token-level deletion can break code, IDs and stack traces, because individual characters disappear rather than whole lines"),
    ],
}
COMPRESR = {
    "id": "compresr", "name": "Compresr", "url": "https://pypi.org/project/compresr",
    "facts": [
        ("Best for", "a hosted compression API from a second vendor, to benchmark against"),
        ("How it works", "query-aware compression through a Python SDK; the default model is called <code>latte_v1</code>"),
        ("Runs", "hosted, with an API key from its dashboard"),
    ],
}
COMPACT = {
    "id": "built-in-compaction", "name": "Built-in compaction (/compact)", "url": "https://docs.anthropic.com/en/docs/claude-code",
    "facts": [
        ("Best for", "sessions that have simply grown too long"),
        ("How it works", "the agent summarizes the conversation so far and continues from the summary"),
        ("Watch out for", "summaries rewrite the original lines, so exact errors, paths and IDs can be lost"),
    ],
}
CONTEXT_MODE = {
    "id": "context-mode", "name": "Context Mode", "url": "https://github.com/mksglu/context-mode",
    "facts": [
        ("Best for", "agents drowning in large MCP and tool results"),
        ("How it works", "an open-source MCP server keeps each full tool result in a sandbox outside the conversation, hands the model a compact version, and indexes the original (SQLite FTS5 with BM25) so the agent can pull details back"),
        ("Watch out for", "its 98% figure comes from the project's own worked examples on supported workflows"),
    ],
}
NEURALMIND = {
    "id": "neuralmind", "name": "NeuralMind", "url": "https://pypi.org/project/neuralmind/",
    "facts": [
        ("Best for", "large codebases where the agent keeps re-reading the same files"),
        ("How it works", "persistent, local codebase memory with semantic retrieval, so the agent asks targeted questions instead of loading whole files; it also compresses tool output through a hook"),
        ("Watch out for", "its 12–50× figures are self-reported, and it is a memory layer more than a compressor"),
    ],
}
BEAR = {
    "id": "the-token-company", "name": "The Token Company (bear-1.1)", "url": "https://thetokencompany.com/",
    "facts": [
        ("Best for", "a hosted compression endpoint for long natural-language prompts"),
        ("How it works", "you send text to the bear compression API and pass the shorter result to your model"),
        ("Watch out for", "its 66% LongBench v2 result is the company's own, and its published pricing descriptions differ, so confirm billing before you commit"),
    ],
}
LANGFUSE = {
    "id": "langfuse", "name": "Langfuse", "url": "https://langfuse.com/",
    "facts": [
        ("Best for", "seeing what your LLM calls cost, per user, feature and model"),
        ("How it works", "open-source tracing with token and cost tracking for every generation, plus evals"),
        ("Runs", "self-hosted for free under the MIT licence, or as Langfuse Cloud"),
        ("Watch out for", "it shows spend; it does not shrink requests on its own"),
    ],
}
PROVIDER = {
    "id": "provider-consoles", "name": "Your provider's usage console", "url": "https://console.anthropic.com/",
    "facts": [
        ("Best for", "a free first look at spend before buying anything"),
        ("How it works", "Anthropic, OpenAI and Google each show usage and cost by key, model and day"),
        ("Watch out for", "no per-task or per-agent breakdown, and no evals or caps across providers"),
    ],
}


def numbered(items, bodies):
    out = []
    for i, (t, b) in enumerate(zip(items, bodies)):
        out.append({**t, "n": i + 1, "body": b})
    return out


PAGES = [
    {
        "slug": "best-caveman-cloud-alternatives",
        "title": "Best Caveman Cloud Alternatives (2026): 6 Options Compared",
        "h1": "Best Caveman Cloud alternatives in 2026",
        "crumb": "Best Caveman Cloud alternatives",
        "keywords": "caveman cloud alternatives, best caveman cloud alternatives, caveman cloud alternative, caveman cloud competitors, caveman cloud vs",
        "description": "The best Caveman Cloud alternatives, split by the job you need done: cutting tokens per request (SuperCompress, Headroom, RTK) or seeing and governing agent spend (Langfuse, provider consoles). What each does, what it costs, and how to test them fairly.",
        "lead": "Caveman Cloud bundles two jobs: it shows a team what its agents cost, and it adds tools to bring that cost down. Most teams need one of those more than the other, so the right alternative depends on which. This guide splits the options by job.",
        "answer": "If you want to <strong>send fewer tokens per request</strong>, the strongest alternatives are SuperCompress (hosted, keeps only the lines that answer the question), Headroom (open source, runs locally) and RTK (shell output only). If you want to <strong>see and govern agent spend</strong>, Langfuse (open source, MIT) or your provider's own usage console. The free, open-source Caveman skill remains an option if you only want shorter replies.",
        "about_h": "What Caveman Cloud is",
        "about": 'Caveman Cloud is the hosted team product from the makers of the open-source Caveman skill. Per <a href="https://caveman.so/pricing" rel="noopener" target="_blank">its pricing page</a>, it includes cost-per-task observability across agents, evals, monitors, an inbox, an "Autopilot" for suggested fixes, model routing and a semantic cache (the cache on the Team plan). There is a free plan for one person and a Team plan at $300 a month that includes $300 of usage, with no per-seat charge. Its docs and pricing page do not agree on every allowance, so check the current numbers there.',
        "criteria": "We picked tools that replace a real part of what Caveman Cloud does, can be tried in an afternoon, and publish enough documentation to describe accurately. Four reduce tokens; two give you spend visibility. We left out anything we could not verify from the vendor's own docs.",
        "tools": numbered(
            [SC, HEADROOM, RTK, CAVEMAN, LANGFUSE, PROVIDER],
            [
                "SuperCompress replaces the cost-cutting half of Caveman Cloud at the source: the bulky context in each request. Your agent or app sends a log, diff, file read or tool result together with the question being asked, and the hosted API returns only the original lines that answer it. Nothing is paraphrased, so error messages, file paths and IDs come through exactly as they were, and every call reports original and kept tokens so you can see the effect on your own traffic.",
                "Headroom is the open-source option for compressing the same kinds of context locally. It picks a compressor for each content type and keeps the originals retrievable, so the model can ask for what was cut. It suits teams that want everything on their own machines and are happy to run and tune a proxy or library.",
                "RTK is narrow and effective: it filters the output of common shell commands before the agent reads it. If most of your waste is <code>git</code>, test and build output, it is a cheap first step, and it pairs well with a tool that handles everything else.",
                "If what you liked about Caveman Cloud was the Caveman skill itself, the skill is free and open source. It makes replies shorter rather than inputs smaller, so measure it on your own tasks before relying on headline figures.",
                "Langfuse replaces the visibility half. It traces every LLM call with token and cost tracking by user, feature and model, adds evals, and is free to self-host under the MIT licence. It does not shrink requests itself, so pair it with one of the tools above.",
                "Before paying for any console, open your provider's usage page. Anthropic, OpenAI and Google all break spend down by key, model and day. It will not attribute cost to individual agent tasks, but it is enough to tell whether you have a problem worth solving.",
            ],
        ),
        "table": {
            "head": ["Tool", "Job", "Runs", "Cost to start"],
            "rows": [
                ["SuperCompress", "Fewer input tokens per request", "Hosted API + MCP", "Free tier"],
                ["Headroom", "Fewer input tokens per request", "Local", "Free, open source"],
                ["RTK", "Smaller shell output", "Local", "Free, open source"],
                ["Caveman skill", "Shorter replies", "Local", "Free, open source"],
                ["Langfuse", "Spend visibility, evals", "Self-host or cloud", "Free self-hosted"],
                ["Provider console", "Spend visibility", "Provider dashboard", "Free"],
            ],
        },
        "related": [("/alternatives", "All alternatives"), ("/alternatives/caveman-cloud", "Caveman Cloud vs SuperCompress"), ("/alternatives/best-caveman-alternatives", "Best Caveman alternatives"), ("/alternatives/best-headroom-alternatives", "Best Headroom alternatives"), ("/cut-llm-api-costs", "Cut LLM API costs")],
        "faq": [
            ("What is the best Caveman Cloud alternative?", "It depends on the job. To send fewer tokens per request, SuperCompress (hosted) or Headroom (open source). To see agent spend, Langfuse or your provider's usage console."),
            ("Is there a free Caveman Cloud alternative?", "Yes. Headroom, RTK, the Caveman skill and self-hosted Langfuse are all free and open source, and SuperCompress has a free tier of 5M tokens a month."),
            ("Does SuperCompress do everything Caveman Cloud does?", "No. SuperCompress is a compression service: it shrinks the context in each request and reports original and kept tokens per call. It is not a team governance console."),
            ("How much does Caveman Cloud cost?", 'Per its pricing page, a free plan for one person and a Team plan at $300 a month including $300 of usage, with no per-seat charge. Check <a href="https://caveman.so/pricing" rel="noopener" target="_blank">caveman.so/pricing</a> for current terms.'),
        ],
    },
    {
        "slug": "best-headroom-alternatives",
        "title": "Best Headroom Alternatives (2026): 9 Context Compression Tools",
        "h1": "Best Headroom alternatives in 2026",
        "crumb": "Best Headroom alternatives",
        "keywords": "headroom alternatives, best headroom alternatives, headroom alternative, headroom ai alternatives, headroom context compression alternatives",
        "description": "The best alternatives to Headroom for cutting the tokens coding agents and LLM apps send: SuperCompress, Context Mode, RTK, NeuralMind, Caveman, LLMLingua-2, Compresr, The Token Company and built-in compaction. How each works and when it beats Headroom.",
        "lead": "Headroom is an open-source context-compression layer for coding agents. If you want something hosted, more selective about the question being asked, narrower, or simply different to benchmark against, these are the alternatives worth trying.",
        "answer": "For hosted, question-aware compression that keeps original lines word for word, <strong>SuperCompress</strong>. For open-source sandboxing of MCP and tool output, <strong>Context Mode</strong>. For noisy shell commands only, <strong>RTK</strong>. For persistent codebase memory instead of compression, <strong>NeuralMind</strong>. For shorter replies, the <strong>Caveman</strong> skill. For research-style token pruning you run yourself, <strong>LLMLingua-2</strong>. For other hosted APIs to compare, <strong>Compresr</strong> and <strong>The Token Company</strong>. And for long sessions, your agent's built-in <strong>/compact</strong>.",
        "about_h": "What Headroom is",
        "about": "Headroom compresses tool output, logs, files, RAG chunks and conversation history before they reach the model, and keeps the originals so the model can ask for them back. It detects each block's content type and applies a matching compressor. It runs locally as a Python or TypeScript library, a proxy, an MCP server or an agent wrapper (<code>headroom wrap claude</code>), and it is released under the Apache 2.0 licence.",
        "criteria": "We kept tools that compress or avoid the same context Headroom targets, have public documentation, and can be tested on your own agent traffic. Each entry says plainly when it is the better choice.",
        "tools": numbered(
            [SC, CONTEXT_MODE, RTK, NEURALMIND, CAVEMAN, LLMLINGUA, COMPRESR, BEAR, COMPACT],
            [
                "SuperCompress is the closest like-for-like alternative, with two differences. It is hosted, so there is no proxy to run, and it is query-aware: instead of compressing by content type, it scores each line against the question the agent is answering and keeps the original lines that matter. Coding agents get it through one setup command; apps call the HTTP API.",
                "Context Mode is the closest open-source alternative for tool output specifically. Rather than compressing a result in place, it parks the full output in a local sandbox and gives the model a compact version it can search, which suits MCP-heavy agents.",
                "RTK solves a slice of Headroom's job very cheaply. It rewrites shell commands to run through output filters, so <code>git</code>, test and build output arrive smaller. It does not touch file reads, MCP results or history.",
                "NeuralMind takes a different route to the same goal: instead of compressing what the agent reads, it builds a persistent local memory of your codebase so the agent fetches less in the first place. Worth trying on large repositories.",
                "Caveman works on the other side of the conversation: it makes agent replies terse. If your bill is dominated by output rather than by what the agent reads, it is worth a test, and it is free.",
                "LLMLingua-2 from Microsoft Research is the reference point for learned prompt compression. It prunes individual tokens with a small classifier. It is a good fit for natural-language prompts in a pipeline you control, and a poorer fit for code and logs, where deleting characters can break meaning.",
                "Compresr is another hosted, query-aware compression API, reached through a Python SDK. If you are choosing a hosted service, benchmark it against SuperCompress on the same traffic.",
                "The Token Company's bear-1.1 is a hosted compression endpoint aimed at long prompts. Like Compresr, it is worth running against your own traffic if you are comparing hosted services.",
                "Every major coding agent can summarize its own history (<code>/compact</code> in Claude Code). It costs nothing and helps with very long sessions, but it rewrites rather than extracts, so precise details can be lost.",
            ],
        ),
        "table": {
            "head": ["Tool", "What it shrinks", "How", "Runs"],
            "rows": [
                ["Headroom", "Tool output, files, logs, RAG, history", "Content-type compressors", "Local"],
                ["SuperCompress", "Tool output, files, logs, MCP results, docs", "Keeps original lines that answer the question", "Hosted"],
                ["Context Mode", "MCP and tool output", "Sandboxes output, indexed retrieval", "Local"],
                ["RTK", "Shell command output", "Command-specific filters", "Local"],
                ["NeuralMind", "Repeated code reads", "Persistent codebase memory", "Local"],
                ["Caveman", "Agent replies", "Terse-reply skill", "Local"],
                ["LLMLingua-2", "Prompt text", "Learned token pruning", "Self-hosted"],
                ["Compresr", "Context", "Query-aware compression", "Hosted"],
                ["The Token Company", "Prompt text", "Hosted compression model", "Hosted"],
                ["/compact", "Session history", "Summarization", "Inside the agent"],
            ],
        },
        "related": [("/alternatives", "All alternatives"), ("/alternatives/headroom", "Headroom vs SuperCompress"), ("/headroom-vs-caveman", "Headroom vs Caveman"), ("/alternatives/best-caveman-cloud-alternatives", "Best Caveman Cloud alternatives"), ("/context-compression-for-coding-agents", "Approaches compared")],
        "faq": [
            ("What is the best Headroom alternative?", "For hosted, question-aware compression of the same context Headroom targets, SuperCompress. For free, open-source options, Context Mode (tool output), RTK (shell output), NeuralMind (codebase memory) or Caveman (replies)."),
            ("Is there a hosted Headroom alternative?", "Yes. SuperCompress, Compresr and The Token Company all offer hosted compression APIs, so there is no local proxy to run."),
            ("Is Headroom free?", "Headroom is open source under the Apache 2.0 licence. Its README also describes a separate offering for organizations."),
            ("Can I use Headroom and SuperCompress together?", "You can, but they compress the same kinds of context, so test them one at a time first and keep whichever gives the lower bill per finished task."),
        ],
    },
    {
        "slug": "best-caveman-alternatives",
        "title": "Best Caveman Alternatives (2026): Cut Agent Tokens Another Way",
        "h1": "Best Caveman alternatives in 2026",
        "crumb": "Best Caveman alternatives",
        "keywords": "caveman alternatives, best caveman alternatives, caveman alternative, caveman claude code alternative, caveman skill alternative",
        "description": "Caveman makes coding agents reply in terse prose to save output tokens. These alternatives cut tokens elsewhere: SuperCompress and Headroom shrink what the agent reads, RTK filters shell output, /compact trims history, and plain output limits cap replies.",
        "lead": "Caveman is a popular skill that makes coding agents answer like cavemen, to spend fewer output tokens. For many agents, though, most of the bill is what they read, not what they write. These alternatives go after that, or cap replies more predictably.",
        "answer": "If your cost comes from what the agent <strong>reads</strong> (logs, files, tool output), use <strong>SuperCompress</strong> (hosted) or <strong>Headroom</strong> (open source). For shell output alone, <strong>RTK</strong>. For long sessions, the built-in <strong>/compact</strong>. To keep replies short without a skill, set an <strong>output token limit</strong> or a one-line style instruction. For team spend visibility, <strong>Caveman Cloud</strong> or Langfuse.",
        "about_h": "What Caveman is",
        "about": 'Caveman is an open-source skill that tells the agent to drop filler words and answer tersely, plus a local proxy that shrinks some tool output. Its makers advertise large output savings; an <a href="https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/" rel="noopener" target="_blank">independent JetBrains A/B test on Claude Code</a> measured 8.5% against an advertised 65%, and the skill adds instructions to the input of every turn. That gap is the main reason people look for alternatives.',
        "criteria": "We looked for tools that cut the same bill from a different direction, or cap replies more predictably, and that you can try on your own agent today.",
        "tools": numbered(
            [SC, HEADROOM, CONTEXT_MODE, RTK, COMPACT,
             {"id": "output-limits", "name": "Output limits and a one-line style rule", "url": "https://docs.anthropic.com/en/api/messages",
              "facts": [("Best for", "short replies with no extra tooling"), ("How it works", "set <code>max_tokens</code> in your app, or add one line such as 'answer in at most five lines' to the agent's instructions"), ("Watch out for", "hard limits can truncate an answer mid-thought")]},
             {"id": "caveman-cloud", "name": "Caveman Cloud", "url": "https://caveman.so/",
              "facts": [("Best for", "teams that want spend analytics, evals and caps across agents"), ("How it works", "a hosted console from the Caveman team"), ("Cost", "free for one person; Team plan at $300 a month including $300 of usage, per its pricing page")]}],
            [
                "SuperCompress attacks the input side. Before a large log, diff or tool result reaches the model, the hosted API keeps only the original lines that answer the current question. Because input usually dwarfs output in agent sessions, this is often where the bigger saving is, and replies stay as detailed as you like.",
                "Headroom is the open-source way to compress the same input locally, with the originals kept retrievable. Choose it if you want everything on your own machine.",
                "Context Mode keeps large tool and MCP results out of the conversation, handing the agent a compact, searchable version instead. A good free option if your agent uses many MCP tools.",
                "RTK filters noisy shell output from commands such as <code>git status</code> and test runners. It is free and quick to install alongside anything else.",
                "Built-in compaction summarizes long sessions so they fit again. Free, but it rewrites the history, so exact details can be lost.",
                "If short replies are all you want, you may not need a skill at all. A token limit in your app, or one concise-style line in the agent's instructions, gets you most of the way with nothing to install.",
                "If you like Caveman and want it for a whole team, its makers offer Caveman Cloud, a hosted console for agent spend, evals and governance.",
            ],
        ),
        "table": {
            "head": ["Option", "Cuts", "Runs", "Cost to start"],
            "rows": [
                ["Caveman skill", "Output (replies)", "Local", "Free"],
                ["SuperCompress", "Input context", "Hosted", "Free tier"],
                ["Headroom", "Input context", "Local", "Free"],
                ["Context Mode", "Tool and MCP output", "Local", "Free"],
                ["RTK", "Shell output", "Local", "Free"],
                ["/compact", "Session history", "Inside the agent", "Free"],
                ["Output limits", "Output", "Your app or prompt", "Free"],
                ["Caveman Cloud", "Spend visibility, governance", "Hosted", "Free for one person"],
            ],
        },
        "related": [("/alternatives", "All alternatives"), ("/alternatives/caveman", "Caveman vs SuperCompress"), ("/headroom-vs-caveman", "Headroom vs Caveman"), ("/alternatives/best-headroom-alternatives", "Best Headroom alternatives"), ("/alternatives/best-caveman-cloud-alternatives", "Best Caveman Cloud alternatives")],
        "faq": [
            ("What is the best Caveman alternative?", "If most of your tokens are what the agent reads, SuperCompress (hosted) or Headroom (open source). If you only want shorter replies, an output limit or a one-line style rule."),
            ("Does Caveman actually save tokens?", "It shortens replies, but an independent JetBrains test measured an 8.5% output saving against an advertised 65%, and the skill adds input tokens each turn. Measure it on your own tasks."),
            ("Can I use Caveman and SuperCompress together?", "Yes. They work on different sides of the conversation: Caveman shortens replies, SuperCompress shrinks the context the agent reads."),
            ("Is there a free Caveman alternative?", "Yes. Headroom, RTK, built-in compaction and output limits are all free, and SuperCompress has a free tier of 5M tokens a month."),
        ],
    },
]

if __name__ == "__main__":
    out = WEB / "alternatives"
    for p in PAGES:
        (out / f'{p["slug"]}.html').write_text(page(p))
        print("wrote", f'web/alternatives/{p["slug"]}.html')
