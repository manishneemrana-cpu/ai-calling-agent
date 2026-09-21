"""ElevenLabsTTSProvider — streaming TTS via ElevenLabs' HTTP streaming
endpoint.

Premium/flagship-quality alternate per docs/VERIFICATION.md §3.3 — the most
expensive TTS option evaluated ($50-100/M chars); reserved for high-value
calls in a tenant's tiering config, never a default.

API shape:
  - Endpoint: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream`
  - Auth: `xi-api-key: <api_key>` header.
  - Body: `{"text": str, "model_id": "eleven_flash_v2_5", "output_format":
    "ulaw_8000"}` — response body is a chunked raw-audio HTTP stream (no
    JSON framing, unlike the WebSocket-based adapters), consumed via
    `response.aiter_bytes()`.

DI: `http_client` injectable (an object exposing an async `.stream(method,
url, **kwargs)` context manager — the `httpx.AsyncClient` shape), same
pattern as the Groq Whisper STT adapter.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import VoiceProfile

ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech"


class ElevenLabsTTSProvider:
    provider_key = "elevenlabs"

    def __init__(self, config: dict[str, Any], *, http_client: Any | None = None):
        api_key = config.get("api_key")
        if not api_key:
            raise ValueError("ElevenLabsTTSProvider requires config.api_key")
        self._api_key = api_key
        self._default_voice_id = config.get("voice_id")
        self._model_id = config.get("model_id", "eleven_flash_v2_5")
        if http_client is None:
            import httpx

            http_client = httpx.AsyncClient()
        self._client = http_client
        self._last_usage: UsageReport | None = None

    async def synthesize_stream(self, text: str, voice_profile: VoiceProfile) -> AsyncIterator[bytes]:
        voice_id = voice_profile.voice_id or self._default_voice_id
        if not voice_id:
            raise ValueError("ElevenLabsTTSProvider requires a voice_id (voice_profile or config default)")
        url = f"{ELEVENLABS_BASE_URL}/{voice_id}/stream"
        headers = {"xi-api-key": self._api_key, "Content-Type": "application/json"}
        body = {"text": text, "model_id": self._model_id, "output_format": "ulaw_8000"}
        async with self._client.stream("POST", url, json=body, headers=headers) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes():
                if chunk:
                    yield chunk
        self._last_usage = UsageReport(
            provider_key=self.provider_key, layer="tts", unit="characters", quantity=len(text)
        )

    def last_usage(self) -> UsageReport:
        if self._last_usage is None:
            raise RuntimeError("ElevenLabsTTSProvider.last_usage() called before any synthesize_stream()")
        return self._last_usage


register_adapter("tts.elevenlabs", lambda config: ElevenLabsTTSProvider(config))
