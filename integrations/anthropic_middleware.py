"""
SuperCompress Anthropic SDK Middleware

Transparent compression for Anthropic/Claude API calls.
Wraps the Anthropic Python SDK to compress context before sending.

Installation:
    pip install supercompress anthropic

Usage:
    from anthropic_middleware import SuperCompressAnthropic

    client = SuperCompressAnthropic(api_key="sk-ant-...")

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        system="You are a helpful assistant.",
        messages=[
            {"role": "user", "content": long_context},
            {"role": "assistant", "content": "Previous response..."},
            {"role": "user", "content": "Follow-up question..."},
        ],
    )
"""

import os
import logging
from typing import Optional

from anthropic import Anthropic
from supercompress import compress_for_turn

logger = logging.getLogger("supercompress")


class SuperCompressAnthropic:
    """Anthropic client wrapper with automatic prompt compression."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        budget_ratio: float = 0.35,
        **kwargs,
    ):
        self._client = Anthropic(api_key=api_key or os.getenv("ANTHROPIC_API_KEY"), **kwargs)
        self.budget_ratio = budget_ratio
        self.total_original_tokens = 0
        self.total_kept_tokens = 0

    @property
    def messages(self):
        return _MessagesWrapper(self)

    def _compress_messages(self, messages: list[dict], system: Optional[str] = None) -> list[dict]:  # noqa: ARG002
        """Compress message history only; leave Anthropic ``system=`` untouched."""
        _ = system
        if len(messages) <= 1:
            return messages

        # Last message should be from user
        last_msg = messages[-1]
        if last_msg.get("role") != "user":
            return messages

        history = messages[:-1]
        query = last_msg["content"]

        # History only — keep Anthropic `system=` wholly outside compression.
        context_parts = []
        for msg in history:
            content = msg.get("content", "")
            if isinstance(content, list):
                content = " ".join(
                    b.get("text", "") for b in content if b.get("type") == "text"
                )
            context_parts.append(f"[{msg['role']}] {content}")

        context = "\n".join(context_parts)

        # Compress
        result = compress_for_turn(context, query, budget_ratio=self.budget_ratio)

        self.total_original_tokens += result.original_tokens
        self.total_kept_tokens += result.kept_tokens

        logger.info(
            f"SuperCompress [Anthropic]: {result.original_tokens}→{result.kept_tokens} tok "
            f"({result.tokens_saved_pct:.1f}%% saved)"
        )

        # Rebuild — query appended once (compress_for_turn does not include it).
        compressed_content = (
            f"[SuperCompress: {result.original_tokens}→{result.kept_tokens} tok, "
            f"{result.tokens_saved_pct:.1f}%% saved]\n\n"
            f"{result.compressed_text}\n\n---\n\n{query}"
        )

        return [{"role": "user", "content": compressed_content}]

    def get_stats(self) -> dict:
        return {
            "total_original_tokens": self.total_original_tokens,
            "total_kept_tokens": self.total_kept_tokens,
            "total_savings_pct": (
                (1 - self.total_kept_tokens / max(self.total_original_tokens, 1)) * 100
                if self.total_original_tokens > 0 else 0
            ),
        }


class _MessagesWrapper:
    def __init__(self, parent: SuperCompressAnthropic):
        self._parent = parent

    def create(self, **kwargs):
        if "messages" in kwargs:
            kwargs["messages"] = self._parent._compress_messages(
                kwargs["messages"],
                kwargs.get("system"),
            )
        return self._parent._client.messages.create(**kwargs)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    client = SuperCompressAnthropic(budget_ratio=0.35)

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=256,
        system="Answer concisely.",
        messages=[
            {
                "role": "user",
                "content": "\n".join([
                    f"Line {i}: The quick brown fox jumps over the lazy dog."
                    for i in range(15)
                ]),
            },
            {"role": "assistant", "content": "I understand the context."},
            {"role": "user", "content": "What is the main subject?"},
        ],
    )

    print(f"Response: {response.content[0].text}")
    print(f"Stats: {client.get_stats()}")
