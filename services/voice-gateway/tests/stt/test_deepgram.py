import json

import pytest

from tests.fakes import make_ws_connect
from voice_gateway.stt.adapters.deepgram import DeepgramSTTProvider


@pytest.mark.asyncio
async def test_deepgram_stt_url_params_and_parsing():
    recv_queue = [
        json.dumps(
            {
                "channel": {"alternatives": [{"transcript": "hello", "confidence": 0.9}]},
                "is_final": False,
            }
        ),
        json.dumps(
            {
                "channel": {"alternatives": [{"transcript": "hello world", "confidence": 0.95}]},
                "is_final": True,
            }
        ),
    ]
    connect, ws = make_ws_connect(recv_queue)
    stt = DeepgramSTTProvider({"api_key": "fake_dg_key", "model": "nova-3"}, ws_connect=connect)

    await stt.start_stream(sample_rate=8000)
    assert "model=nova-3" in ws.connect_url
    assert ws.connect_kwargs["additional_headers"] == {"Authorization": "Token fake_dg_key"}

    events = [e async for e in stt.feed_audio_chunk(b"\x00" * 80)]
    assert events[0].type == "partial"
    assert events[0].confidence == 0.9

    events = [e async for e in stt.feed_audio_chunk(b"\x00" * 80)]
    assert events[0].type == "final"
    assert events[0].text == "hello world"

    ws._recv_queue.append(json.dumps({"channel": {"alternatives": []}}))
    _final, usage = await stt.end_stream()
    assert json.loads(ws.sent[-1]) == {"type": "CloseStream"}
    assert usage.provider_key == "deepgram"
    assert usage.quantity > 0


def test_deepgram_requires_api_key():
    with pytest.raises(ValueError):
        DeepgramSTTProvider({})
