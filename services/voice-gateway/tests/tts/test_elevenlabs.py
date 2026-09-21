import pytest

from tests.fakes import FakeHTTPClient, FakeStreamResponse
from voice_gateway.tts.adapters.elevenlabs import ElevenLabsTTSProvider
from voice_gateway.tts.types import VoiceProfile


@pytest.mark.asyncio
async def test_elevenlabs_streams_raw_audio_bytes():
    client = FakeHTTPClient(stream_response=FakeStreamResponse(byte_chunks=[b"abc", b"def"]))
    tts = ElevenLabsTTSProvider({"api_key": "fake_key", "voice_id": "voice1"}, http_client=client)

    chunks = [c async for c in tts.synthesize_stream("hello", VoiceProfile())]
    assert chunks == [b"abc", b"def"]

    call = client.stream_calls[0]
    assert call["url"].endswith("/voice1/stream")
    assert call["headers"]["xi-api-key"] == "fake_key"
    assert call["json"]["model_id"] == "eleven_flash_v2_5"

    usage = tts.last_usage()
    assert usage.quantity == len("hello")


@pytest.mark.asyncio
async def test_elevenlabs_requires_voice_id():
    client = FakeHTTPClient()
    tts = ElevenLabsTTSProvider({"api_key": "fake_key"}, http_client=client)
    with pytest.raises(ValueError):
        async for _ in tts.synthesize_stream("hi", VoiceProfile()):
            pass
