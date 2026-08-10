#!/usr/bin/env python3
"""Demo: local query-aware compress on synthetic multi-block context."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from supercompress import CompressResult, compress_for_turn

NOTES = """## Session notes
- User asked about fetch() behavior when rows are missing
- Prior attempts used head/tail truncation and lost the answer line
- Need to preserve function definitions and entity matches
"""

CODE = """## api/client.py
class ApiClient:
    def fetch(self, row_id: int):
        row = self.db.get(row_id)
        if row is None:
            return None
        return row.to_dict()
"""

SUMMARY = """## Summary
1. Compress context before LLM inference
2. Keep entity-bearing lines under budget
3. Log tokens_saved_pct each call
"""


def main() -> None:
    blocks = [NOTES, CODE, SUMMARY]
    query = "What does fetch return when the row is missing?"

    print("SuperCompress — local compress demo\n")
    print(f"Question: {query}\n")

    result: CompressResult = compress_for_turn(
        context="\n\n---\n\n".join(blocks),
        user_query=query,
        context_blocks=blocks,
        budget_ratio=0.35,
    )

    print(f"── {result.policy_name} ({result.mode})")
    print(f"   tokens: {result.original_tokens} → {result.kept_tokens}")
    print(f"   saved:  {result.tokens_saved} ({result.tokens_saved_pct:.1f}%)")
    preview = result.compressed_text[:220].replace("\n", " ")
    print(f"   preview: {preview}…")


if __name__ == "__main__":
    main()
