"""MockEmbeddingProvider — deterministic, hash-based fake vectors, no
network calls. Same role as every other layer's `mock` adapter: demo mode
and the whole test suite run against this with no live embedding API key,
and — unlike a real embedding model — its output is fully deterministic
(the same text always embeds to the same vector), which is exactly what
makes `tests/knowledge/test_ingestion_and_retrieval.py`'s "does this query
retrieve the right chunks" assertions possible without a live model."""

from __future__ import annotations

import hashlib

from ...adapter_map import register_adapter
from ...usage import UsageReport

DEFAULT_DIMENSIONS = 768


class MockEmbeddingProvider:
    provider_key = "mock"

    def __init__(self, config: dict | None = None):
        config = config or {}
        self.dimensions: int = config.get("dimensions", DEFAULT_DIMENSIONS)

    async def embed(self, texts: list[str]) -> tuple[list[list[float]], UsageReport]:
        vectors = [self._embed_one(text) for text in texts]
        total_chars = sum(len(t) for t in texts)
        usage = UsageReport(
            provider_key=self.provider_key, layer="embedding", unit="characters", quantity=total_chars
        )
        return vectors, usage

    def _embed_one(self, text: str) -> list[float]:
        """Deterministic pseudo-embedding: repeatedly hash the text to fill
        `dimensions` floats in [-1, 1]. Two semantically-similar texts don't
        get similar vectors here (this is NOT a real embedding model) —
        tests that need "is text X more relevant to query Y than text Z" use
        texts engineered to share/not-share vocabulary in a way this simple
        scheme still distinguishes (see `_embed_one`'s use of word-level
        hashing below, not just whole-string hashing, specifically so
        shared-keyword texts land closer together than unrelated ones)."""
        vector = [0.0] * self.dimensions
        words = text.lower().split() or [text.lower()]
        for word in words:
            digest = hashlib.sha256(word.encode("utf-8")).digest()
            for i in range(self.dimensions):
                byte = digest[i % len(digest)]
                vector[i] += (byte / 255.0) * 2 - 1
        norm = sum(v * v for v in vector) ** 0.5 or 1.0
        return [v / norm for v in vector]


register_adapter("embedding.mock", lambda config: MockEmbeddingProvider(config))
