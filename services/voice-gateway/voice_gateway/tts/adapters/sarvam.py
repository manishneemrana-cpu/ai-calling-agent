"""SarvamTTSProvider — streaming TTS via Sarvam Bulbul's WebSocket API.

Primary TTS provider per docs/VERIFICATION.md §3.1/STACK_PROPOSAL.md —
cheapest verified option (~Rs 30/10,000 chars), confirmed streaming, 30+
Indian-language voices.

API shape:
  - Endpoint: `wss://api.sarvam.ai/text-to-speech/ws` (Sarvam's streaming
    TTS WebSocket, per docs.sarvam.ai's "Streaming Text-to-Speech API").
  - Model: `bulbul:v3`.
  - Auth: `API-SUBSCRIPTION-KEY` header.
  - Protocol: client sends a JSON `config` message (target_language_code,
    speaker, pace/speed, output audio format), then a `text` message per
    utterance; server streams back JSON frames `{"type": "audio", "data":
    {"audio": "<base64 pcm/mulaw chunk>"}}` until `{"type": "end"}`.

DI: `ws_connect` injectable, same pattern as the STT adapters.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Callable
from typing import Any

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import VoiceProfile

SARVAM_TTS_WS_URL = "wss://api.sarvam.ai/text-to-speech/ws"


async def _default_ws_connect(url: str, **kwargs: Any) -> Any:
    import websockets

    return await websockets.connect(url, **kwargs)


class SarvamTTSProvider:
    provider_key = "sarvam"

    def __init__(self, config: dict[str, Any], *, ws_connect: Callable[..., Any] | None = None):
        api_key = config.get("api_key")
        if not api_key:
            raise ValueError("SarvamTTSProvider requires config.api_key")
        self._api_key = api_key
        self._model = config.get("model", "bulbul:v3")
        self._default_speaker = config.get("speaker", "anushka")
        self._ws_connect = ws_connect or _default_ws_connect
        self._last_usage: UsageReport | None = None

    async def synthesize_stream(self, text: str, voice_profile: VoiceProfile) -> AsyncIterator[bytes]:
        ws = await self._ws_connect(
            SARVAM_TTS_WS_URL, additional_headers={"API-SUBSCRIPTION-KEY": self._api_key}
        )
        try:
            await ws.send(
                json.dumps(
                    {
                        "type": "config",
                        "model": self._model,
                        "speaker": voice_profile.voice_id or self._default_speaker,
                        "pace": voice_profile.speed,
                        "target_language_code": voice_profile.language or "hi-IN",
                        "output_audio_codec": "audio/x-mulaw",
                    }
                )
            )
            await ws.send(json.dumps({"type": "text", "data": {"text": text}}))
            while True:
                raw = await ws.recv()
                payload = json.loads(raw if isinstance(raw, str) else raw.decode("utf-8"))
                if payload.get("type") == "end":
                    break
                if payload.get("type") == "audio":
                    audio_b64 = payload.get("data", {}).get("audio", "")
                    if audio_b64:
                        yield base64.b64decode(audio_b64)
        finally:
            await ws.close()
        self._last_usage = UsageReport(
            provider_key=self.provider_key, layer="tts", unit="characters", quantity=len(text)
        )

    def last_usage(self) -> UsageReport:
        if self._last_usage is None:
            raise RuntimeError("SarvamTTSProvider.last_usage() called before any synthesize_stream()")
        return self._last_usage


register_adapter("tts.sarvam", lambda config: SarvamTTSProvider(config))
