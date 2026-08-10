"""Shared compression result type for local + hosted API paths."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class CompressResult:
    """Result of a SuperCompress compression call (local engine or hosted API).

    ``tokens_saved_pct`` is percent of prompt tokens removed:
    ``(1 - kept/original) * 100``.

    API-only fields (``kept_line_ratio``, ``cache_prefix_applied``) default
    so local and hosted callers share one type.
    """

    compressed_text: str
    original_tokens: int = 0
    kept_tokens: int = 0
    tokens_saved_pct: float = 0.0
    policy_name: str = "supercompress"
    mode: str = "compiler"
    keep_ratio: float = 0.35
    tokens_saved: Optional[int] = None
    kept_line_ratio: float = 0.0
    cache_prefix_applied: bool = False
    compression_risk: Optional[float] = None
    confidence: Optional[float] = None
    ccr: Optional[dict[str, Any]] = None

    def __post_init__(self) -> None:
        if self.tokens_saved is None:
            self.tokens_saved = max(0, self.original_tokens - self.kept_tokens)

    @property
    def savings_pct(self) -> float:
        if self.original_tokens == 0:
            return 0.0
        return (1 - self.kept_tokens / self.original_tokens) * 100

    @property
    def kv_savings_pct(self) -> float:
        """Deprecated alias of tokens_saved_pct."""
        return self.tokens_saved_pct

    def to_dict(self) -> dict[str, Any]:
        saved = self.tokens_saved if self.tokens_saved is not None else max(0, self.original_tokens - self.kept_tokens)
        return {
            "compressed_text": self.compressed_text,
            "original_tokens": self.original_tokens,
            "kept_tokens": self.kept_tokens,
            "tokens_saved": saved,
            "savings_pct": round(self.savings_pct, 1),
            "tokens_saved_pct": self.tokens_saved_pct,
            "kv_savings_pct": self.tokens_saved_pct,  # deprecated alias
            "kept_line_ratio": self.kept_line_ratio,
            "policy_name": self.policy_name,
            "mode": self.mode,
            "keep_ratio": self.keep_ratio,
            "cache_prefix_applied": self.cache_prefix_applied,
            "compression_risk": self.compression_risk,
            "confidence": self.confidence,
            "ccr": self.ccr,
        }


__all__ = ["CompressResult"]
