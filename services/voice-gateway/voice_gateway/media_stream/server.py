"""The WebSocket connection handler for a live call's media stream.

`handle_media_stream()` is deliberately framework/transport-agnostic: it
takes anything with an async `.send(str)` / `.recv() -> str` shape (a real
`websockets` server connection in production, or `tests/fakes.py`'s
`FakeWebSocket` in tests) — the same dependency-injection pattern already
used throughout this codebase's adapters (see `tests/fakes.py`'s docstring).
This is what makes "simulate a provider's real WebSocket protocol hitting
this endpoint" testable without spinning up an actual TCP listener.

Flow (see docs/AUDIO_BRIDGE.md for the full diagram):
  1. Resolve this call's provider frame adapter (`media_stream.<provider_key>`).
  2. Look up the `ConversationOrchestrator` `PipelineManager.start_pipeline()`
     already built for this `call_id` from the "call answered" webhook.
  3. Decode inbound provider frames into raw audio bytes, feed them into
     `ConversationOrchestrator.run_turn()`'s `AsyncIterator[bytes]` — the
     EXACT same orchestrator entrypoint the all-mock pipeline test
     (`tests/test_pipeline_e2e.py`) already exercises with a fake generator.
     A provider's `interruption`-shaped event (FreJun Teler) triggers
     `BargeInController.trigger()` directly.
  4. Encode each synthesized TTS chunk `run_turn()` yields back into that
     SAME provider's outbound frame format and send it on the WebSocket.

Scope note: this handles one conversational turn per WebSocket connection
(ending on the provider's own `stop` event, or the connection closing) —
matching the orchestrator's existing single-turn `run_turn()` contract from
Phase 3. Multi-turn continuous-conversation turn-boundary detection over one
persistent call (silence-based VAD segmentation feeding `run_turn()`
repeatedly) is real follow-up work, listed in docs/AUDIO_BRIDGE.md.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Protocol

from .pipeline_manager import PipelineManager
from .registry import resolve_media_stream_adapter
from .types import MediaStreamEvent


class MediaStreamSocket(Protocol):
    """The minimal shape `handle_media_stream()` needs — satisfied by both a
    real `websockets` server connection and `tests/fakes.py`'s
    `FakeWebSocket`."""

    async def send(self, data: str) -> None: ...

    async def recv(self) -> str: ...


class ConnectionClosed(Exception):
    """Raised internally to signal the inbound-frame generator should stop.
    A real `websockets` connection raises its own
    `websockets.exceptions.ConnectionClosed` on `.recv()` when the peer
    disconnects — this handler treats ANY exception from `.recv()` as an
    ended stream (documented limitation: a real transient network error is
    indistinguishable from a clean close here; see docs/AUDIO_BRIDGE.md)."""


async def _inbound_audio_frames(
    ws: MediaStreamSocket,
    adapter: Any,
    *,
    on_interruption: Any,
    on_event: Any = None,
) -> AsyncIterator[bytes]:
    while True:
        try:
            raw_message = await ws.recv()
        except Exception:
            return
        event: MediaStreamEvent = adapter.parse_inbound(raw_message)
        if on_event is not None:
            on_event(event)
        if event.kind == "media" and event.audio:
            yield event.audio
        elif event.kind == "interruption":
            on_interruption()
        elif event.kind == "stop":
            return
        # "start"/"dtmf"/"unknown" carry no audio for this turn — ignored here.


async def handle_media_stream(
    ws: MediaStreamSocket,
    *,
    call_id: str,
    provider_key: str,
    pipeline_manager: PipelineManager,
) -> None:
    """Drives exactly one conversational turn for `call_id` over `ws`,
    using `provider_key`'s frame adapter (`media_stream.plivo` /
    `media_stream.frejun_teler`)."""
    adapter = resolve_media_stream_adapter(provider_key)
    orchestrator = pipeline_manager.get_orchestrator(call_id)

    def _on_interruption() -> None:
        orchestrator.barge_in.trigger()

    audio_frames = _inbound_audio_frames(ws, adapter, on_interruption=_on_interruption)

    async for tts_chunk in orchestrator.run_turn(audio_frames):
        await ws.send(adapter.encode_outbound_audio(tts_chunk))
