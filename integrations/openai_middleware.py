"""
SuperCompress OpenAI SDK Middleware

A transparent middleware wrapper for the OpenAI Python SDK.
Automatically compresses conversation context before sending to the API.
Supports both streaming and non-streaming responses.

Installation:
    pip install supercompress openai

Usage:
    from openai_middleware import SuperCompressOpenAI

    # Wrap your OpenAI client
    client = SuperCompressOpenAI(
        api_key="sk-...",
        budget_ratio=0.35,  # keep 35%% of tokens
    )

    # Use exactly like the regular OpenAI client
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[...],
    )

    # Streaming also works
    stream = client.chat.completions.create(
        model="gpt-4o",
        messages=[...],
        stream=True,
    )
    for chunk in stream:
        print(chunk.choices[0].delta.content or "", end="")
"""

import os
import logging
from typing import Any, Optional, Union

from openai import OpenAI
from openai.types.chat import ChatCompletion
from openai.types.chat.chat_completion_chunk import ChatCompletionChunk

from supercompress import compress_for_turn

logger = logging.getLogger("supercompress")


class SuperCompressOpenAI:
    """OpenAI client wrapper with automatic prompt compression.
    
    Supports both streaming (stream=True) and non-streaming responses.
    Tracks cumulative token savings via get_stats().
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        budget_ratio: float = 0.35,
        base_url: Optional[str] = None,
        **kwargs,
    ):
        api_key = api_key or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "OpenAI API key required. Pass it to SuperCompressOpenAI() "
                "or set the OPENAI_API_KEY environment variable."
            )
        self._client = OpenAI(api_key=api_key, base_url=base_url, **kwargs)
        self.budget_ratio = budget_ratio
        self.total_original_tokens = 0
        self.total_kept_tokens = 0

    @property
    def chat(self):
        return _ChatWrapper(self)

    @property
    def models(self):
        return self._client.models

    def _compress_messages(self, messages: list[dict]) -> list[dict]:
        """Compress conversation history, preserving system and latest user message."""
        if len(messages) <= 2:
            return messages

        system_msgs = [m for m in messages if m.get("role") == "system"]
        non_system = [m for m in messages if m.get("role") != "system"]

        if len(non_system) < 2:
            return messages

        last_msg = non_system[-1]
        if last_msg.get("role") != "user":
            return messages

        history = non_system[:-1]
        query = last_msg["content"]

        context_lines = []
        for msg in history:
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            context_lines.append(f"[{role}] {content}")

        context = "\n".join(context_lines)

        result = compress_for_turn(context, query, budget_ratio=self.budget_ratio)

        self.total_original_tokens += result.original_tokens
        self.total_kept_tokens += result.kept_tokens

        savings = result.tokens_saved_pct
        logger.info(
            f"SuperCompress: {result.original_tokens}→{result.kept_tokens} tok "
            f"({savings:.1f}%% saved) — policy={result.policy_name}"
        )

        compressed_content = (
            f"[SuperCompress: {result.original_tokens}→{result.kept_tokens} tok, "
            f"{savings:.1f}%% saved]\n\n"
            f"{result.compressed_text}\n\n---\n\n{query}"
        )

        return system_msgs + [{"role": "user", "content": compressed_content}]

    def get_stats(self) -> dict:
        """Return cumulative compression statistics."""
        return {
            "total_original_tokens": self.total_original_tokens,
            "total_kept_tokens": self.total_kept_tokens,
            "total_savings_pct": (
                (1 - self.total_kept_tokens / max(self.total_original_tokens, 1)) * 100
                if self.total_original_tokens > 0
                else 0
            ),
        }


class _ChatWrapper:
    def __init__(self, parent: SuperCompressOpenAI):
        self._parent = parent

    @property
    def completions(self):
        return _CompletionWrapper(self._parent)


class _CompletionWrapper:
    def __init__(self, parent: SuperCompressOpenAI):
        self._parent = parent

    def create(self, **kwargs) -> Union[ChatCompletion, "Stream[ChatCompletionChunk]"]:
        if "messages" in kwargs:
            kwargs["messages"] = self._parent._compress_messages(kwargs["messages"])
        return self._parent._client.chat.completions.create(**kwargs)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    client = SuperCompressOpenAI(budget_ratio=0.35)

    # Non-streaming test
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": "Answer concisely."},
            {
                "role": "user",
                "content": "\n".join([
                    f"Context line {i}: The quick brown fox jumps over the lazy dog."
                    for i in range(20)
                ]),
            },
            {"role": "assistant", "content": "I understand the context."},
            {"role": "user", "content": "Summarize the key points in one sentence."},
        ],
    )

    print(f"Response: {response.choices[0].message.content}")
    print(f"Stats: {client.get_stats()}")
