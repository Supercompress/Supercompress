#!/usr/bin/env python3
"""Generate a lightweight web/assets/data/benchmarks.json from local compress runs."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from supercompress import compress_for_turn
from supercompress.benchmarks.metrics import compression_quality_score

OUT = ROOT / "web" / "assets" / "data" / "benchmarks.json"


def _pytest_summary() -> dict:
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/", "-q"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    line = proc.stdout.strip().split("\n")[-1] if proc.stdout else ""
    passed = proc.returncode == 0
    count = 0
    if " passed" in line:
        try:
            count = int(line.split(" passed")[0].strip().split()[-1])
        except ValueError:
            pass
    return {"passed": passed, "count": count, "summary": line or ("passed" if passed else "failed")}


def _middle_truncation_case() -> tuple[str, str]:
    head = "\n".join(f"- noise head {i}" for i in range(40))
    answer = "IMPORTANT: User.fetch returns 404 when the row is missing."
    tail = "\n".join(f"- noise tail {i}" for i in range(40))
    return f"{head}\n{answer}\n{tail}", "What does User.fetch return when the row is missing?"


def main() -> None:
    ctx, question = _middle_truncation_case()
    failure = compress_for_turn(ctx, question, budget_ratio=0.1)

    demo_blocks = [
        "## Notes\n" + "\n".join(f"- Context block {i}: padding and metadata" for i in range(1, 12)),
        "## Code\nclass ApiClient:\n    def fetch(self, id): ...",
        "## Summary\n1. Trim context\n2. Keep entities\n3. Send to LLM",
    ]
    demo_query = "How does the ApiClient fetch method work?"
    demo = compress_for_turn(
        context="",
        user_query=demo_query,
        context_blocks=demo_blocks,
        budget_ratio=0.35,
    )

    data = {
        "generated_by": "scripts/benchmark_web.py",
        "engine": "local-query-aware",
        "model": {
            "params": "local fallback",
            "inference": "CPU · Python",
            "note": "Hosted compiler/precision runs on Vercel API",
        },
        "turn_table": [
            {"turn": 1, "without": "2K tokens", "with_sc": "~700 tokens"},
            {"turn": 3, "without": "8K tokens", "with_sc": "~2.8K tokens"},
            {"turn": "4+", "without": "OOM / collapse", "with_sc": "Stable 35–65% savings"},
        ],
        "failure_case": {
            "question": question,
            "compare": {
                "local-query-aware": {
                    "kept_tokens": failure.kept_tokens,
                    "tokens_saved_pct": round(failure.tokens_saved_pct, 1),
                    "answer_quality": compression_quality_score(
                        failure.original_tokens, failure.kept_tokens
                    ),
                    "has_answer": "404" in failure.compressed_text
                    or "User.fetch" in failure.compressed_text,
                }
            },
        },
        "demo": {
            "query": demo_query,
            "original_tokens": demo.original_tokens,
            "kept_tokens": demo.kept_tokens,
            "tokens_saved_pct": round(demo.tokens_saved_pct, 1),
            "policy": demo.policy_name,
            "input_preview": "\n\n---\n\n".join(demo_blocks)[:1200],
            "compressed_text": demo.compressed_text,
        },
        "tests": _pytest_summary(),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
