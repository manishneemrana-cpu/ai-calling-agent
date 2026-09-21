"""Simulates a fake client sending frames in Plivo's real documented
WebSocket media-stream format at `handle_media_stream()`, proving it:
  1. correctly decodes Plivo's `start`/`media`/`stop` JSON events and base64
     mulaw audio into raw bytes,
  2. feeds that audio to MockSTT and gets a MockLLM reply through the exact
     same `ConversationOrchestrator` Phase 3 already tests, and
  3. sends back correctly-Plivo-framed (`playAudio`, `audio/x-mulaw`,
     base64) synthesized audio on the same connection.

See docs/AUDIO_BRIDGE.md for the cited source of Plivo's message format.
"""

from __future__ import annotations

import base64
import json

import pytest

from tests.fakes import FakeWebSocket
from voice_gateway.llm.adapters.mock import MockLLMProvider
from voice_gateway.media_stream.pipeline_manager import PipelineManager
from voice_gateway.media_stream.server import handle_media_stream
from voice_gateway.stt.adapters.mock import MockSTTProvider
from voice_gateway.tts.adapters.mock import MockTTSProvider


def _plivo_start(stream_id: str = "MZ123") -> str:
    return json.dumps(
        {
            "event": "start",
            "streamId": stream_id,
            "start": {
                "streamId": stream_id,
                "callId": "CA123",
                "accountId": "AC123",
                "tracks": ["inbound"],
                "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1},
            },
        }
    )


def _plivo_media(chunk: bytes, stream_id: str = "MZ123", seq: int = 1) -> str:
    return json.dumps(
        {
            "event": "media",
            "sequenceNumber": seq,
            "streamId": stream_id,
            "media": {
                "track": "inbound",
                "chunk": str(seq),
                "timestamp": str(seq * 20),
                "payload": base64.b64encode(chunk).decode("ascii"),
            },
        }
    )


def _plivo_stop(stream_id: str = "MZ123") -> str:
    return json.dumps({"event": "stop", "streamId": stream_id, "stop": {"callId": "CA123"}})


@pytest.mark.asyncio
async def test_plivo_media_stream_decodes_audio_and_sends_back_correctly_framed_tts():
    manager = PipelineManager()
    manager.start_pipeline_with_providers(
        "call-plivo-1",
        "org-1",
        stt=MockSTTProvider(),
        llm=MockLLMProvider(),
        tts=MockTTSProvider(),
    )

    # MockSTTProvider's canned transcript has 12 words — feed 12 media
    # frames of mulaw silence so the 12th chunk triggers a "final" event,
    # exactly like the mock e2e pipeline test's own chunk-count contract.
    inbound = [_plivo_start()]
    inbound += [_plivo_media(b"\x00" * 160, seq=i) for i in range(1, 13)]
    inbound += [_plivo_stop()]

    ws = FakeWebSocket(inbound)

    await handle_media_stream(ws, call_id="call-plivo-1", provider_key="plivo", pipeline_manager=manager)

    assert len(ws.sent) > 0
    for message in ws.sent:
        decoded = json.loads(message)
        assert decoded["event"] == "playAudio"
        assert decoded["media"]["contentType"] == "audio/x-mulaw"
        assert decoded["media"]["sampleRate"] == 8000
        # Round-trips as valid base64 mulaw "audio" (mock TTS's zeroed frame).
        raw_audio = base64.b64decode(decoded["media"]["payload"])
        assert raw_audio == b"\x00" * 320  # MockTTSProvider's default chunk_size

    orchestrator = manager.get_orchestrator("call-plivo-1")
    assert orchestrator.messages[0].role == "user"
    assert "recent order" in orchestrator.messages[0].content


def test_plivo_frame_adapter_encode_clear_matches_documented_barge_in_message():
    from voice_gateway.media_stream.adapters.plivo import PlivoMediaStreamAdapter

    adapter = PlivoMediaStreamAdapter()
    assert json.loads(adapter.encode_clear()) == {"event": "clearAudio"}


def test_plivo_frame_adapter_parses_dtmf_event():
    from voice_gateway.media_stream.adapters.plivo import PlivoMediaStreamAdapter

    adapter = PlivoMediaStreamAdapter()
    event = adapter.parse_inbound(json.dumps({"event": "dtmf", "streamId": "s1", "dtmf": {"digit": "5"}}))
    assert event.kind == "dtmf"
    assert event.digit == "5"
