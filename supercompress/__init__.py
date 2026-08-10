"""
SuperCompress — prompt compression for LLM applications.

Compress long context windows into their most token-efficient form
while preserving answer quality. Works as a standalone library, an
LLM SDK middleware layer, a browser-side engine, and an MCP server.

Typical usage:

    from supercompress import compress_for_turn

    result = compress_for_turn(
        context="",
        user_query=user_message,
        context_blocks=[system_prompt, tool_outputs, chat_history],
        budget_ratio=0.35,
    )
    # Send `result.compressed_text` to your LLM instead of the full context.

For the hosted API (API key required):

    from supercompress.client import SuperCompress

    sc = SuperCompress(api_key="sc_live_...")
    result = sc.compress(context, query, mode="precision")
"""

from __future__ import annotations

import os
import re
from typing import Optional

from .result import CompressResult

__version__ = "0.6.1"

_QUERY_STOPWORDS = {
    "what",
    "how",
    "does",
    "do",
    "the",
    "is",
    "are",
    "was",
    "were",
    "why",
    "when",
    "where",
    "which",
    "who",
    "whom",
    "whose",
    "function",
    "return",
    "returns",
    "returning",
    "class",
    "def",
    "import",
    "from",
    "this",
    "that",
    "with",
    "into",
    "about",
    "for",
    "and",
    "or",
    "of",
    "to",
}

# ── Local compression engine ────────────────────────────────────────


def compress_for_turn(
    context: str,
    user_query: str,
    context_blocks: Optional[list[str]] = None,
    budget_ratio: float = 0.35,
    mode: str = "compiler",
) -> CompressResult:
    """
    Compress conversation context for the current user query.

    Local ``compiler`` mode is a lightweight query-aware fallback (not the
    hosted engine). ``mode="precision"`` calls the hosted API when
    ``SUPERCOMPRESS_API_KEY`` is set; otherwise it raises ``RuntimeError``.

    Args:
        context: Full context to compress (ignored when ``context_blocks`` is set).
        user_query: Current user question — used for retention scoring only
            (not appended to ``compressed_text``).
        context_blocks: Optional list of blocks joined before compression.
        budget_ratio: Fraction of lines to keep; must be in ``(0, 1]``.
        mode: ``"compiler"`` (local) or ``"precision"`` (hosted when keyed).

    Returns:
        A :class:`CompressResult` with compressed context and statistics.

    Raises:
        ValueError: If ``budget_ratio`` is not in ``(0, 1]``.
        RuntimeError: If ``mode="precision"`` and no API key is configured.
    """
    if not (0.0 < float(budget_ratio) <= 1.0):
        raise ValueError(f"budget_ratio must be in (0, 1], got {budget_ratio!r}")

    mode_norm = (mode or "compiler").strip().lower()
    if context_blocks:
        context = "\n".join(context_blocks)
    context = context if context is not None else ""

    if mode_norm == "precision":
        api_key = os.getenv("SUPERCOMPRESS_API_KEY")
        if not api_key:
            raise RuntimeError(
                'mode="precision" requires SUPERCOMPRESS_API_KEY '
                "(hosted quality-guaranteed path). Use mode=\"compiler\" for local fallback, "
                "or set a key from https://supercompress.dev/dashboard"
            )
        # Lazy import avoids circular init when SuperCompress is re-exported below.
        from .client import SuperCompress

        return SuperCompress(api_key=api_key).compress(
            context,
            user_query,
            mode="precision",
            budget_ratio=budget_ratio,
        )

    if not str(context).strip():
        return CompressResult(
            compressed_text="",
            original_tokens=0,
            kept_tokens=0,
            tokens_saved_pct=0.0,
            policy_name="noop",
            mode=mode_norm,
            keep_ratio=budget_ratio,
        )

    lines = context.split("\n")
    n = len(lines)
    keep = min(n, max(1, int(round(n * budget_ratio))))

    query_terms = _extract_query_terms(user_query)
    blocks = _segment_blocks(lines)
    scored_blocks = []
    for block_index, (start, end) in enumerate(blocks):
        block_lines = lines[start : end + 1]
        score = _score_block(block_lines, query_terms, block_index, len(blocks), start, end, n)
        scored_blocks.append((score, start, end, block_lines))

    scored_blocks.sort(key=lambda item: (-item[0], item[1]))

    selected: list[tuple[int, int, list[str]]] = []
    used = 0
    for score, start, end, block_lines in scored_blocks:
        block_len = len(block_lines)
        if selected and used + block_len > keep and used >= max(1, keep // 2):
            continue
        selected.append((start, end, block_lines))
        used += block_len
        if used >= keep:
            break

    if not selected:
        selected = [(0, min(n - 1, keep - 1), lines[:keep])]

    selected.sort(key=lambda item: item[0])
    kept_lines = [line for _, _, block_lines in selected for line in block_lines]

    if len(kept_lines) > keep:
        kept_lines = _trim_selected_lines(kept_lines, query_terms, keep)

    original_tokens = _estimate_tokens(context)
    kept_text = "\n".join(kept_lines)
    kept_tokens = _estimate_tokens(kept_text)
    savings = round((1 - kept_tokens / max(original_tokens, 1)) * 100, 1)

    return CompressResult(
        compressed_text=kept_text,
        original_tokens=original_tokens,
        kept_tokens=kept_tokens,
        tokens_saved_pct=savings,
        policy_name="local-query-aware",
        mode=mode_norm,
        keep_ratio=budget_ratio,
    )



def _estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars per token)."""
    return max(1, len(text) // 4)


def _extract_query_terms(user_query: str) -> list[str]:
    terms: list[str] = []
    seen: set[str] = set()
    for raw in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", user_query or ""):
        term = raw.lower()
        if len(term) <= 2 or term in _QUERY_STOPWORDS or term in seen:
            continue
        seen.add(term)
        terms.append(term)
    return terms


def _segment_blocks(lines: list[str]) -> list[tuple[int, int]]:
    blocks: list[tuple[int, int]] = []
    start: Optional[int] = None
    for idx, line in enumerate(lines):
        if line.strip():
            if start is None:
                start = idx
        elif start is not None:
            blocks.append((start, idx - 1))
            start = None
    if start is not None:
        blocks.append((start, len(lines) - 1))
    return blocks or [(0, len(lines) - 1)]


def _score_block(
    block_lines: list[str],
    query_terms: list[str],
    block_index: int,
    total_blocks: int,
    start: int,
    end: int,
    total_lines: int,
) -> float:
    score = 0.0
    first_line = block_lines[0].strip() if block_lines else ""
    block_text = "\n".join(block_lines)
    lower_text = block_text.lower()

    if start == 0:
        score += 0.25
    if end >= total_lines - 1:
        score += 0.25
    if block_index == 0 or block_index == max(0, total_blocks - 1):
        score += 0.15

    if first_line.startswith("#"):
        score += 0.8
    if re.match(r"^(def|class|async\s+def|function|const|let|var|public|private|protected|static)\b", first_line):
        score += 0.8
    if re.match(r"^(\d+\.|[-*+])\s+", first_line):
        score += 0.25
    if re.match(r"^(traceback|error|exception|failed|timeout|denied|invalid)\b", lower_text):
        score += 0.35

    if query_terms:
        hits = sum(1 for term in query_terms if term in lower_text)
        score += hits * 1.8
        for term in query_terms:
            if first_line and term in first_line.lower():
                score += 0.9
    else:
        score += 0.05

    if len(block_lines) > 6 and not query_terms:
        score -= 0.15

    return score


def _trim_selected_lines(kept_lines: list[str], query_terms: list[str], keep: int) -> list[str]:
    if len(kept_lines) <= keep:
        return kept_lines

    scored = []
    total = len(kept_lines)
    for idx, line in enumerate(kept_lines):
        score = 0.0
        lower = line.lower()
        if idx == 0:
            score += 0.25
        if idx == total - 1:
            score += 0.25
        if line.strip().startswith("#"):
            score += 0.6
        if re.match(r"^(def|class|async\s+def|function|const|let|var|public|private|protected|static)\b", line.strip()):
            score += 0.6
        for term in query_terms:
            if term in lower:
                score += 1.6
        scored.append((score, idx, line))

    scored.sort(key=lambda item: (-item[0], item[1]))
    chosen = sorted(idx for _, idx, _ in scored[:keep])
    return [kept_lines[i] for i in chosen]


def compress_context(
    text: str,
    query: str,
    budget_ratio: float = 0.35,
) -> CompressResult:
    """Alias for :func:`compress_for_turn` with a single context string."""
    return compress_for_turn(text, query, budget_ratio=budget_ratio)


# ── Public API ──────────────────────────────────────────────────────

from .client import SuperCompress

__all__ = [
    "compress_for_turn",
    "compress_context",
    "CompressResult",
    "SuperCompress",
    "__version__",
]
