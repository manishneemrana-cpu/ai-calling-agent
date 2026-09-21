import base64
import json

import pytest

from tests.fakes import make_ws_connect
from voice_gateway.tts.adapters.sarvam import SarvamTTSProvider
from voice_gateway.tts.types import VoiceProfile


@pytest.mark.asyncio
async def test_sarvam_tts_streams_decoded_audio_chunks():
    audio_b64 = base64.b64encode(b"\x01\x02\x03").decode()
    recv_queue = [
        json.dumps({"type": "audio", "data": {"audio": audio_b64}}),
        json.dumps({"type": "end"}),
    ]
    connect, ws = make_ws_connect(recv_queue)
    tts = SarvamTTSProvider({"api_key": "fake_key", "speaker": "anushka"}, ws_connect=connect)

    chunks = [c async for c in tts.synthesize_stream("namaste", VoiceProfile(language="hi-IN"))]
    assert chunks == [b"\x01\x02\x03"]
    assert ws.closed is True

    config_msg = json.loads(ws.sent[0])
    assert config_msg["type"] == "config"
    assert config_msg["model"] == "bulbul:v3"
    assert config_msg["speaker"] == "anushka"
    text_msg = json.loads(ws.sent[1])
    assert text_msg == {"type": "text", "data": {"text": "namaste"}}

    usage = tts.last_usage()
    assert usage.provider_key == "sarvam"
    assert usage.quantity == len("namaste")


def test_sarvam_tts_requires_api_key():
    with pytest.raises(ValueError):
        SarvamTTSProvider({})
