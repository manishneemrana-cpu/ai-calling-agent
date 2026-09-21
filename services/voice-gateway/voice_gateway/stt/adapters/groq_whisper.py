"""GroqWhisperSTTProvider — batch/chunked STT via Groq's hosted Whisper
large-v3-turbo, using Groq's OpenAI-compatible `/audio/transcriptions`
endpoint.

Alternate STT provider per docs/VERIFICATION.md §2.3 — cheapest option
found (~$0.04/hr of audio), but explicitly NOT a native low-latency
streaming socket like Sarvam/Deepgram: Groq's hosted Whisper is a
request/response REST endpoint. This adapter therefore implements the same
STTProvider streaming Protocol by *buffering* fed chunks and transcribing on
`end_stream()` (or whenever the caller explicitly flushes a buffered
window) — a legitimate "chunked near-real-time" mode per
docs/PROVIDER_REGISTRY.md's capabilities flag for this provider
(`chunked_near_realtime: true`), not a native partial-transcript stream. It
only ever yields `type="final"` events, never `type="partial"`.

API shape:
  - Endpoint: `POST https://api.groq.com/openai/v1/audio/transcriptions`
    (OpenAI Whisper-compatible multipart/form-data: `file`, `model`).
  - Model: `whisper-large-v3-turbo`.
  - Auth: `Authorization: Bearer <api_key>`.
  - Response: `{"text": str}` (verbose_json also available with segments,
    not needed for this adapter's minimal contract).

Dependency injection: takes an `http_client` (an object exposing an async
`.post(url, **kwargs)` — the same shape as `httpx.AsyncClient`), so tests
inject a fake client with zero live network/API key, exactly the Phase 2
Plivo/FreJun DI pattern.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import TranscriptEvent

GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"


class GroqWhisperSTTProvider:
    provider_key = "groq_whisper"

    def __init__(self, config: dict[str, Any], *, http_client: Any | None = None):
        api_key = config.get("api_key")
        if not api_key:
            raise ValueError("GroqWhisperSTTProvider requires config.api_key")
        self._api_key = api_key
        self._model = config.get("model", "whisper-large-v3-turbo")
        if http_client is None:
            import httpx

            http_client = httpx.AsyncClient()
        self._client = http_client
        self._buffer = bytearray()
        self._sample_rate = 8000
        self._audio_seconds_buffered = 0.0

    async def start_stream(self, *, sample_rate: int = 8000, language: str | None = None) -> None:
        self._sample_rate = sample_rate
        self._buffer.clear()
        self._audio_seconds_buffered = 0.0

    async def feed_audio_chunk(self, chunk: bytes) -> AsyncIterator[TranscriptEvent]:
        # Buffer only — Groq's REST endpoint has no native partial-result
        # streaming, so nothing is yielded here (see module docstring).
        self._buffer.extend(chunk)
        self._audio_seconds_buffered += len(chunk) / self._sample_rate
        return
        yield  # pragma: no cover - makes this an async generator function

    async def end_stream(self) -> tuple[TranscriptEvent | None, UsageReport]:
        usage = UsageReport(
            provider_key=self.provider_key,
            layer="stt",
            unit="seconds",
            quantity=self._audio_seconds_buffered,
        )
        if not self._buffer:
            return None, usage

        files = {"file": ("audio.raw", bytes(self._buffer), "audio/basic")}
        data = {"model": self._model}
        headers = {"Authorization": f"Bearer {self._api_key}"}
        response = await self._client.post(GROQ_TRANSCRIBE_URL, files=files, data=data, headers=headers)
        response.raise_for_status()
        payload = response.json()
        text = payload.get("text", "").strip()
        self._buffer.clear()
        if not text:
            return None, usage
        return TranscriptEvent(type="final", text=text, confidence=None), usage


register_adapter("stt.groq_whisper", lambda config: GroqWhisperSTTProvider(config))
