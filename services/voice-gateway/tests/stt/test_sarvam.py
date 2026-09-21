import json

import pytest

from tests.fakes import make_ws_connect
from voice_gateway.stt.adapters.sarvam import SarvamSTTProvider


@pytest.mark.asyncio
async def test_sarvam_stt_sends_config_and_parses_partial_and_final():
    recv_queue = [
        json.dumps({"type": "data", "data": {"transcript": "hi there", "is_final": False}}),
        json.dumps({"type": "data", "data": {"transcript": "hi there friend", "is_final": True}}),
    ]
    connect, ws = make_ws_connect(recv_queue)
    stt = SarvamSTTProvider({"api_key": "fake_api_key"}, ws_connect=connect)

    await stt.start_stream(sample_rate=8000, language="hi-IN")
    assert ws.connect_kwargs["additional_headers"] == {"API-SUBSCRIPTION-KEY": "fake_api_key"}
    config_sent = json.loads(ws.sent[0])
    assert config_sent["type"] == "config"
    assert config_sent["model"] == "saaras:v3-realtime"
    assert config_sent["language_code"] == "hi-IN"

    events = [e async for e in stt.feed_audio_chunk(b"\x00" * 160)]
    assert events[0].type == "partial"
    assert events[0].text == "hi there"

    events = [e async for e in stt.feed_audio_chunk(b"\x00" * 160)]
    assert events[0].type == "final"
    assert events[0].text == "hi there friend"

    # end_stream sends an explicit "end" and closes the socket
    ws._recv_queue.append(json.dumps({"type": "end"}))
    _final, usage = await stt.end_stream()
    assert json.loads(ws.sent[-1]) == {"type": "end"}
    assert ws.closed is True
    assert usage.unit == "seconds"
    assert usage.provider_key == "sarvam"


def test_sarvam_stt_requires_api_key():
    with pytest.raises(ValueError):
        SarvamSTTProvider({})
