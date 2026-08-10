#!/usr/bin/env python3
"""Minimal stdin pipeline: context + question → compressed text + stats."""

from __future__ import annotations

import json
import sys

from supercompress import compress_context
from supercompress.benchmarks.metrics import sustainability_from_tokens_saved


def main() -> None:
    if len(sys.argv) < 3:
        print("Usage: raw_pipeline.py <context.txt> <question> [budget]", file=sys.stderr)
        raise SystemExit(2)

    context_path, question = sys.argv[1], sys.argv[2]
    budget = float(sys.argv[3]) if len(sys.argv) > 3 else 0.35
    text = open(context_path, encoding="utf-8").read()

    result = compress_context(text, question, budget_ratio=budget)
    saved = result.original_tokens - result.kept_tokens
    impact = sustainability_from_tokens_saved(saved)

    print(result.compressed_text)
    print("\n--- stats ---", file=sys.stderr)
    print(
        json.dumps(
            {
                "original_tokens": result.original_tokens,
                "kept_tokens": result.kept_tokens,
                "tokens_saved_pct": result.tokens_saved_pct,
                "policy": result.policy_name,
                "co2_kg_avoided": impact.co2_saved_kg,
            },
            indent=2,
        ),
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
