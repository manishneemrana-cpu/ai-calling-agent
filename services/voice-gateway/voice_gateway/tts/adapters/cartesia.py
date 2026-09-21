"""CartesiaTTSProvider — streaming TTS via Cartesia's WebSocket API.

Premium low-latency alternate per docs/VERIFICATION.md §3.2 — ~90ms
time-to-first-audio on Sonic-3, English/global-language focus (not a
Hindi-first primary).

API shape:
  - Endpoint: `wss://api.cartesia.ai/tts/websocket?api_key=<key>&cartesia_version=2026-06-10`
  - Model: `sonic-3` (also `sonic-turbo` for the lowest-latency variant).
  - Protocol: client sends one JSON message per utterance: `{"model_id":
    "sonic-3", "transcript": str, "voice": {"mode": "id", "id": voice_id},
    "output_format": {"container": "raw", "encoding": "pcm_mulaw",
    "sample_rate": 8000}, "context_id": str}`; server streams back JSON
    frames `{"type": "chunk", "data": "<base64 audio>"}` until `{"type":
    "done"}`.

DI: `ws_connect` injectable, same pattern as the other streaming adapters.
"""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import VoiceProfile

CARTESIA_WS_URL = "wss://api.cartesia.ai/tts/websocket"
CARTESIA_API_VERSION = "2026-06-10"


async def _default_ws_connect(url: str, **kwargs: Any) -> Any:
    import websockets

    return await websockets.connect(url, **kwargs)


class CartesiaTTSProvider:
    provider_key = "cartesia"

    def __init__(self, config: dict[str, Any], *, ws_connect: Callable[..., Any] | None = None):
        api_key = config.get("api_key")
        if not api_key:
            raise ValueError("CartesiaTTSProvider requires config.api_key")
        self._api_key = api_key
        self._model = config.get("model", "sonic-3")
        self._default_voice_id = config.get("voice_id")
        self._ws_connect = ws_connect or _default_ws_connect
        self._last_usage: UsageReport | None = None

    async def synthesize_stream(self, text: str, voice_profile: VoiceProfile) -> AsyncIterator[bytes]:
        voice_id = voice_profile.voice_id or self._default_voice_id
        if not voice_id:
            raise ValueError("CartesiaTTSProvider requires a voice_id (voice_profile or config default)")
        url = f"{CARTESIA_WS_URL}?api_key={self._api_key}&cartesia_version={CARTESIA_API_VERSION}"
        ws = await self._ws_connect(url)
        try:
            await ws.send(
                json.dumps(
                    {
                        "model_id": self._model,
                        "transcript": text,
                        "voice": {"mode": "id", "id": voice_id},
                        "output_format": {
                            "container": "raw",
                            "encoding": "pcm_mulaw",
                            "sample_rate": 8000,
                        },
                        "context_id": str(uuid.uuid4()),
                    }
                )
            )
            while True:
                raw = await ws.recv()
                payload = json.loads(raw if isinstance(raw, str) else raw.decode("utf-8"))
                if payload.get("type") == "done":
                    break
                if payload.get("type") == "chunk" and payload.get("data"):
                    yield base64.b64decode(payload["data"])
        finally:
            await ws.close()
        self._last_usage = UsageReport(
            provider_key=self.provider_key, layer="tts", unit="characters", quantity=len(text)
        )

    def last_usage(self) -> UsageReport:
        if self._last_usage is None:
            raise RuntimeError("CartesiaTTSProvider.last_usage() called before any synthesize_stream()")
        return self._last_usage


register_adapter("tts.cartesia", lambda config: CartesiaTTSProvider(config))
