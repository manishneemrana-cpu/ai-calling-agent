import base64
import json

import pytest

from tests.fakes import make_ws_connect
from voice_gateway.tts.adapters.cartesia import CartesiaTTSProvider
from voice_gateway.tts.types import VoiceProfile


@pytest.mark.asyncio
async def test_cartesia_tts_streams_decoded_chunks():
    audio_b64 = base64.b64encode(b"\xaa\xbb").decode()
    recv_queue = [
        json.dumps({"type": "chunk", "data": audio_b64}),
        json.dumps({"type": "done"}),
    ]
    connect, ws = make_ws_connect(recv_queue)
    tts = CartesiaTTSProvider({"api_key": "fake_key", "voice_id": "v1"}, ws_connect=connect)

    chunks = [c async for c in tts.synthesize_stream("hello", VoiceProfile())]
    assert chunks == [b"\xaa\xbb"]

    sent = json.loads(ws.sent[0])
    assert sent["model_id"] == "sonic-3"
    assert sent["voice"] == {"mode": "id", "id": "v1"}
    assert sent["output_format"]["encoding"] == "pcm_mulaw"


@pytest.mark.asyncio
async def test_cartesia_tts_requires_voice_id():
    connect, _ws = make_ws_connect([])
    tts = CartesiaTTSProvider({"api_key": "fake_key"}, ws_connect=connect)
    with pytest.raises(ValueError):
        async for _ in tts.synthesize_stream("hello", VoiceProfile()):
            pass
