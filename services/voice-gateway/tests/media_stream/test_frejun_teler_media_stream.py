"""Same proof as test_plivo_media_stream.py, but for FreJun Teler's
documented WebSocket message shape (`{"type": "audio", "data":
{"audio_b64": ...}}` inbound / `{"type": "audio", "audio_b64": ...,
"chunk_id": N}` outbound), plus its `interruption` barge-in signal — a
DIFFERENT JSON shape from Plivo's `event`-keyed messages, proving the
per-provider frame-adapter design actually handles two genuinely different
wire protocols, not just two field-name variants of the same one.
"""

from __future__ import annotations

import base64
import json

import pytest

from tests.fakes import FakeWebSocket
from voice_gateway.llm.adapters.mock import MockLLMProvider
from voice_gateway.media_stream.adapters.frejun_teler import FreJunTelerMediaStreamAdapter
from voice_gateway.media_stream.pipeline_manager import PipelineManager
from voice_gateway.media_stream.server import _inbound_audio_frames, handle_media_stream
from voice_gateway.stt.adapters.mock import MockSTTProvider
from voice_gateway.tts.adapters.mock import MockTTSProvider


def _frejun_audio(chunk: bytes) -> str:
    return json.dumps({"type": "audio", "data": {"audio_b64": base64.b64encode(chunk).decode("ascii")}})


def _frejun_interruption() -> str:
    return json.dumps({"type": "interruption"})


@pytest.mark.asyncio
async def test_frejun_teler_media_stream_decodes_audio_and_sends_back_correctly_framed_tts():
    manager = PipelineManager()
    manager.start_pipeline_with_providers(
        "call-frejun-1",
        "org-1",
        stt=MockSTTProvider(),
        llm=MockLLMProvider(),
        tts=MockTTSProvider(),
    )

    inbound = [_frejun_audio(b"\x00\x01" * 80) for _ in range(12)]
    ws = FakeWebSocket(inbound)
    # FakeWebSocket.recv() raises once its queue is exhausted — that's the
    # "connection closed" boundary this handler treats as end-of-turn (see
    # server.py's ConnectionClosed docstring), same as the real
    # websockets library raising on a peer disconnect.

    await handle_media_stream(
        ws, call_id="call-frejun-1", provider_key="frejun_teler", pipeline_manager=manager
    )

    assert len(ws.sent) > 0
    for i, message in enumerate(ws.sent):
        decoded = json.loads(message)
        assert decoded["type"] == "audio"
        assert decoded["chunk_id"] == i  # monotonically increasing per connection
        raw_audio = base64.b64decode(decoded["audio_b64"])
        assert raw_audio == b"\x00" * 320


@pytest.mark.asyncio
async def test_frejun_teler_interruption_message_triggers_the_barge_in_callback():
    """Proves the media-stream reader loop itself recognizes FreJun Teler's
    `interruption` message and invokes the callback that would trigger
    `BargeInController` — tested at this narrower unit boundary (rather than
    asserting `barge_in.is_interrupted()` after a full `handle_media_stream`
    run) because `ConversationOrchestrator._reply_and_speak()` legitimately
    calls `barge_in.reset()` right before each TTS turn starts (Phase 3's
    own contract, see orchestrator/pipeline.py), so an interruption that
    arrives during the STT-feeding phase is *correctly* wiped before
    playback begins — asserting the callback fires is the deterministic,
    ordering-independent way to prove the wiring, without depending on
    exact interleaving between this fake transport and the orchestrator's
    sequential single-generator turn (a real live call's genuinely
    concurrent full-duplex audio is one of the things
    docs/AUDIO_BRIDGE.md's follow-up list says still needs a live account
    to verify end-to-end)."""
    adapter = FreJunTelerMediaStreamAdapter()
    ws = FakeWebSocket([_frejun_audio(b"\x00\x01" * 80), _frejun_interruption()])

    interrupted = False

    def _on_interruption() -> None:
        nonlocal interrupted
        interrupted = True

    chunks = [chunk async for chunk in _inbound_audio_frames(ws, adapter, on_interruption=_on_interruption)]

    assert chunks == [b"\x00\x01" * 80]
    assert interrupted is True


def test_frejun_teler_frame_adapter_has_no_documented_clear_message():
    from voice_gateway.media_stream.adapters.frejun_teler import FreJunTelerMediaStreamAdapter

    adapter = FreJunTelerMediaStreamAdapter()
    assert adapter.encode_clear() is None
