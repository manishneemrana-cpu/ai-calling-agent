"""EmbeddingProvider — the adapter contract every embedding provider
implements. Same Protocol/self-registration shape as
STTProvider/TTSProvider/LLMProvider (docs/PROVIDER_REGISTRY.md)."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from ..usage import UsageReport


@runtime_checkable
class EmbeddingProvider(Protocol):
    provider_key: str
    dimensions: int

    async def embed(self, texts: list[str]) -> tuple[list[list[float]], UsageReport]:
        """Embeds a batch of texts, returning one vector per input text (in
        the same order) plus a single UsageReport for the whole batch call."""
        ...
