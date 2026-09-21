"""SarvamSTTProvider — real-time streaming STT via Sarvam's WebSocket API.

Primary STT provider per docs/VERIFICATION.md §2.1/§9.7 and
docs/STACK_PROPOSAL.md: strongest verified Hindi/Hinglish code-switching
quality, INR-priced (~Rs 0.50/min).

API shape (re-verified 2026-09-21, see the dated appendix in
docs/VERIFICATION.md this adapter is built against):
  - Endpoint: `wss://api.sarvam.ai/speech-to-text/ws` (realtime streaming).
  - Model: `saaras:v3-realtime` (default) or `saaras:v4-realtime` — both
    accept the same connection parameters/message protocol. This supersedes
    the older Saarika v2.5 batch model this spec originally named (Sarvam
    is steering customers off it).
  - Auth: `API-SUBSCRIPTION-KEY` header (server-side) or the
    `api-subscription-key.<key>` WebSocket subprotocol (browser use only —
    this service uses the header form, being a trusted server).
  - Protocol: after connecting, the client sends a JSON `config` message
    (language_code, sample_rate, etc), then binary audio frames; the server
    sends back JSON transcript events `{"type": "data", "data": {"transcript":
    str, "is_final": bool}}` (interim vs. final per Sarvam's realtime
    streaming doc).

Dependency injection: takes a `ws_connect` callable (defaults to
`websockets.connect`) so tests can inject a fake async-context-manager
WebSocket with zero real network access or API key — exactly the Plivo/
FreJun pattern from Phase 2 (constructor takes injectable clients, never
requires live credentials to be importable/instantiable).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from typing import Any

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import TranscriptEvent

SARVAM_WS_URL = "wss://api.sarvam.ai/speech-to-text/ws"


async def _default_ws_connect(url: str, **kwargs: Any) -> Any:
    """Real network path: opens a `websockets` connection and returns the
    live connection object directly (not the `Connect` async-context-manager
    wrapper), so callers/tests only ever deal with one calling convention:
    `ws = await ws_connect(url, ...)`."""
    import websockets

    return await websockets.connect(url, **kwargs)


class SarvamSTTProvider:
    provider_key = "sarvam"

    def __init__(self, config: dict[str, Any], *, ws_connect: Callable[..., Any] | None = None):
        api_key = config.get("api_key")
        if not api_key:
            raise ValueError("SarvamSTTProvider requires config.api_key")
        self._api_key = api_key
        self._model = config.get("model", "saaras:v3-realtime")
        self._language_code = config.get("language_code", "hi-IN")
        if ws_connect is None:
            ws_connect = _default_ws_connect
        self._ws_connect = ws_connect
        self._ws = None
        self._audio_seconds_sent = 0.0
        self._sample_rate = 8000

    async def start_stream(self, *, sample_rate: int = 8000, language: str | None = None) -> None:
        self._sample_rate = sample_rate
        self._ws = await self._ws_connect(
            SARVAM_WS_URL,
            additional_headers={"API-SUBSCRIPTION-KEY": self._api_key},
        )
        await self._ws.send(
            json.dumps(
                {
                    "type": "config",
                    "model": self._model,
                    "language_code": language or self._language_code,
                    "sample_rate": sample_rate,
                    "encoding": "audio/x-mulaw",
                }
            )
        )
        self._audio_seconds_sent = 0.0

    async def feed_audio_chunk(self, chunk: bytes) -> AsyncIterator[TranscriptEvent]:
        if self._ws is None:
            raise RuntimeError("SarvamSTTProvider.feed_audio_chunk called before start_stream")
        await self._ws.send(chunk)
        # mulaw @ 8kHz mono = 1 byte/sample
        self._audio_seconds_sent += len(chunk) / self._sample_rate
        raw = await self._ws.recv()
        event = self._parse_event(raw)
        if event is not None:
            yield event

    async def end_stream(self) -> tuple[TranscriptEvent | None, UsageReport]:
        last_final: TranscriptEvent | None = None
        if self._ws is not None:
            await self._ws.send(json.dumps({"type": "end"}))
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
        if payload.get("type") != "data":
            return None
        data = payload.get("data", {})
        transcript = data.get("transcript", "")
        is_final = bool(data.get("is_final", False))
        return TranscriptEvent(
            type="final" if is_final else "partial",
            text=transcript,
            confidence=data.get("confidence"),
        )


register_adapter("stt.sarvam", lambda config: SarvamSTTProvider(config))
