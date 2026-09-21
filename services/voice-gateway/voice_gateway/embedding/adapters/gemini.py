"""GeminiEmbeddingProvider — batch text embeddings via Google's Gemini API,
the same vendor/API surface `llm/adapters/gemini.py` already uses (so
onboarding embeddings doesn't mean a whole second vendor relationship).

API shape (`batchEmbedContents`, Google's documented batch embedding
endpoint):
  - Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/
    models/{model}:batchEmbedContents?key=<api_key>`
  - Body: `{"requests": [{"model": "models/{model}", "content":
    {"parts": [{"text": str}]}} for each input text]}`
  - Response: `{"embeddings": [{"values": [float, ...]}, ...]}`, one entry
    per request, in the same order.
  - Default model `text-embedding-004`: 768-dimensional output, matching
    `knowledge_chunks.embedding`'s `vector(768)` column width exactly (no
    truncation/padding needed) — this is WHY 004 rather than Google's
    newer `gemini-embedding-001` (which defaults to 3072 dimensions and
    would require either a schema change or Matryoshka truncation to fit
    this column; out of scope for this phase, noted here rather than
    silently mismatched).

Re-verify current pricing/model availability before go-live — same caveat
repeated on every other adapter's docstring in this codebase (see
docs/VERIFICATION.md's dated re-verification appendix for why this matters:
model names/pricing in this space change within weeks).

DI: `http_client` injectable (`httpx.AsyncClient`-shaped `.post()`), same
pattern as every other real adapter in this codebase.
"""

from __future__ import annotations

from typing import Any

from ...adapter_map import register_adapter
from ...usage import UsageReport

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_MODEL = "text-embedding-004"
DEFAULT_DIMENSIONS = 768


class GeminiEmbeddingProvider:
    provider_key = "gemini"

    def __init__(self, config: dict[str, Any], *, http_client: Any | None = None):
        api_key = config.get("api_key")
        if not api_key:
            raise ValueError("GeminiEmbeddingProvider requires config.api_key")
        self._api_key = api_key
        self._model = config.get("model", DEFAULT_MODEL)
        self.dimensions = DEFAULT_DIMENSIONS
        if http_client is None:
            import httpx

            http_client = httpx.AsyncClient()
        self._client = http_client

    async def embed(self, texts: list[str]) -> tuple[list[list[float]], UsageReport]:
        url = f"{GEMINI_BASE_URL}/{self._model}:batchEmbedContents"
        body = {
            "requests": [
                {"model": f"models/{self._model}", "content": {"parts": [{"text": text}]}} for text in texts
            ]
        }
        response = await self._client.post(url, params={"key": self._api_key}, json=body)
        response.raise_for_status()
        payload = response.json()
        vectors = [embedding["values"] for embedding in payload.get("embeddings", [])]

        total_chars = sum(len(t) for t in texts)
        usage = UsageReport(
            provider_key=self.provider_key, layer="embedding", unit="characters", quantity=total_chars
        )
        return vectors, usage


register_adapter("embedding.gemini", lambda config: GeminiEmbeddingProvider(config))
