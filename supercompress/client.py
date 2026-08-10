"""
SuperCompress Hosted API Client

Communicates with the SuperCompress compression API at
``https://www.supercompress.dev/api/v1/compress``.

Supports compiler, precision, and CCR (reversible) compression modes.

Typical usage:

    from supercompress.client import SuperCompress

    sc = SuperCompress(api_key="sc_live_YOUR_KEY")
    result = sc.compress(
        context="Long context text to compress...",
        query="What is the answer?",
        mode="precision",
    )
    print(f"Compressed ({result.original_tokens} → {result.kept_tokens} tok)")
    print(result.compressed_text)
"""

from __future__ import annotations

import os
from typing import Any, Optional

import httpx

from .result import CompressResult

BASE_URL = os.environ.get("SUPERCOMPRESS_API_URL", "https://www.supercompress.dev")
COMPRESS_ENDPOINT = "/api/v1/compress"
RETRIEVE_ENDPOINT = "/api/retrieve"


class SuperCompress:
    """Client for the SuperCompress hosted compression API.

    Args:
        api_key: SuperCompress API key. If omitted, reads from the
                 ``SUPERCOMPRESS_API_KEY`` environment variable.
        base_url: Override the API base URL (default: ``https://www.supercompress.dev``).
        timeout: HTTP request timeout in seconds (default: 30).
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = BASE_URL,
        timeout: float = 30.0,
    ):
        self.api_key = api_key or os.getenv("SUPERCOMPRESS_API_KEY")
        if not self.api_key:
            raise ValueError(
                "SuperCompress API key required. Pass it to SuperCompress() "
                "or set the SUPERCOMPRESS_API_KEY environment variable."
            )
        self.base_url = base_url.rstrip("/")
        connect_timeout = min(5.0, timeout) if timeout > 0 else 5.0
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={"X-API-Key": self.api_key},
            timeout=httpx.Timeout(
                timeout,
                connect=connect_timeout,
            ),
            follow_redirects=True,
        )

    def compress(
        self,
        context: str,
        query: str,
        mode: str = "compiler",
        budget_ratio: Optional[float] = None,
        ccr: bool = False,
        cache_prefix: bool = False,
    ) -> CompressResult:
        """Compress a long context using the hosted API.

        Args:
            context: The full context text to compress.
            query: The user's current query (kept intact).
            mode: Compression mode — ``"compiler"`` (default, maximum
                  reduction), ``"precision"`` (quality-guaranteed with
                  verifier), or ``"fixed"`` (exact ``budget_ratio``).
            budget_ratio: Fraction of tokens to keep (0.0–1.0). Required
                          for ``mode="fixed"``, optional for others.
            ccr: Enable Cache-Compress-Retrieve for reversible compression.
            cache_prefix: Wrap output in a deterministic preamble so
                          providers can reuse prompt/prefix cache across
                          requests. SuperCompress does not touch model KV
                          cache; this only reshapes the text we send.

        Returns:
            A :class:`CompressResult` with compressed text and statistics.
        """
        payload: dict[str, Any] = {
            "context": context,
            "query": query,
            "mode": mode,
            "ccr": ccr,
            "cache_prefix": cache_prefix,
        }
        if budget_ratio is not None:
            payload["budget_ratio"] = budget_ratio

        resp = self._client.post(COMPRESS_ENDPOINT, json=payload)
        resp.raise_for_status()
        data = resp.json()

        original = int(data.get("original_tokens", 0) or 0)
        kept = int(data.get("kept_tokens", 0) or 0)
        saved = data.get("tokens_saved")
        if saved is None:
            saved = max(0, original - kept)

        return CompressResult(
            compressed_text=data.get("compressed_text", ""),
            original_tokens=original,
            kept_tokens=kept,
            tokens_saved=int(saved),
            tokens_saved_pct=float(
                data.get("tokens_saved_pct", data.get("kv_savings_pct", 0.0)) or 0.0
            ),
            kept_line_ratio=float(data.get("kept_line_ratio", 0.0) or 0.0),
            policy_name=data.get("policy_name", "") or "supercompress",
            mode=data.get("mode", mode),
            keep_ratio=float(data.get("keep_ratio", budget_ratio or 0.35) or 0.35),
            cache_prefix_applied=bool(data.get("cache_prefix_applied", False)),
            compression_risk=data.get("compression_risk"),
            confidence=data.get("confidence"),
            ccr=data.get("ccr"),
        )

    def retrieve(self, hash: str) -> Optional[str]:
        """Retrieve the original text for a CCR hash.

        Args:
            hash: The content-addressed hash from a CCR marker
                  (``[SC-Retrieve: <hash>]``).

        Returns:
            The original text, or ``None`` if the hash is not found.
        """
        resp = self._client.get(RETRIEVE_ENDPOINT, params={"hash": hash})
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json().get("original")

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "SuperCompress":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


__all__ = ["SuperCompress", "CompressResult"]
