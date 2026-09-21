"""DeepgramSTTProvider — real-time streaming STT via Deepgram's WebSocket API.

Alternate STT provider per docs/VERIFICATION.md §2.2 — $0.0077/min PAYG
streaming, strong English/multilingual, credible fallback when a tenant's
call mix is English-heavy.

API shape:
  - Endpoint: `wss://api.deepgram.com/v1/listen?model=nova-3&encoding=mulaw
    &sample_rate=8000&interim_results=true`
  - Auth: `Authorization: Token <api_key>` header.
  - Protocol: send raw binary audio frames directly (no JSON envelope,
    unlike Sarvam); Deepgram streams back JSON results shaped like
    `{"channel": {"alternatives": [{"transcript": str, "confidence": float}]},
    "is_final": bool, "duration": float}` per utterance/window. Sending the
    text message `{"type": "CloseStream"}` flushes and ends the session.

Same dependency-injection pattern as the Sarvam adapter: `ws_connect` is
injectable so tests never need a live Deepgram API key.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from typing import Any
from urllib.parse import urlencode

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import TranscriptEvent

DEEPGRAM_WS_BASE = "wss://api.deepgram.com/v1/listen"


async def _default_ws_connect(url: str, **kwargs: Any) -> Any:
    import websockets

    return await websockets.connect(url, **kwargs)


class DeepgramSTTProvider:
    provider_key = "deepgram"

    def __init__(self, config: dict[str, Any], *, ws_connect: Callable[..., Any] | None = None):
        api_key = config.get("api_key")
        if not api_key:
            raise ValueError("DeepgramSTTProvider requires config.api_key")
        self._api_key = api_key
        self._model = config.get("model", "nova-3")
        self._language = config.get("language", "en")
        self._ws_connect = ws_connect or _default_ws_connect
        self._ws = None
        self._audio_seconds_sent = 0.0
        self._sample_rate = 8000

    async def start_stream(self, *, sample_rate: int = 8000, language: str | None = None) -> None:
        self._sample_rate = sample_rate
        params = urlencode(
            {
                "model": self._model,
                "language": language or self._language,
                "encoding": "mulaw",
                "sample_rate": sample_rate,
                "interim_results": "true",
            }
        )
        self._ws = await self._ws_connect(
            f"{DEEPGRAM_WS_BASE}?{params}",
            additional_headers={"Authorization": f"Token {self._api_key}"},
        )
        self._audio_seconds_sent = 0.0

    async def feed_audio_chunk(self, chunk: bytes) -> AsyncIterator[TranscriptEvent]:
        if self._ws is None:
            raise RuntimeError("DeepgramSTTProvider.feed_audio_chunk called before start_stream")
        await self._ws.send(chunk)
        self._audio_seconds_sent += len(chunk) / self._sample_rate
        raw = await self._ws.recv()
        event = self._parse_event(raw)
        if event is not None:
            yield event

    async def end_stream(self) -> tuple[TranscriptEvent | None, UsageReport]:
        last_final: TranscriptEvent | None = None
        if self._ws is not None:
            await self._ws.send(json.dumps({"type": "CloseStream"}))
            try:
                raw = await self._ws.recv()
                event = self._parse_event(raw)
                if event and event.type == "final":
                    last_final = event
            except Exception:
                pass
            await self._ws.close()
            self._ws = None
        usage = UsageReport(
            provider_key=self.provider_key, layer="stt", unit="seconds", quantity=self._audio_seconds_sent
        )
        return last_final, usage

    @staticmethod
    def _parse_event(raw: str | bytes) -> TranscriptEvent | None:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        payload = json.loads(raw)
        alternatives = payload.get("channel", {}).get("alternatives", [])
        if not alternatives:
            return None
        transcript = alternatives[0].get("transcript", "")
        if not transcript:
            return None
        is_final = bool(payload.get("is_final", False))
        return TranscriptEvent(
            type="final" if is_final else "partial",
            text=transcript,
            confidence=alternatives[0].get("confidence"),
        )


register_adapter("stt.deepgram", lambda config: DeepgramSTTProvider(config))
