import pytest

from tests.fakes import FakeHTTPClient, FakeStreamResponse
from voice_gateway.tts.adapters.piper import PiperTTSProvider
from voice_gateway.tts.types import VoiceProfile


@pytest.mark.asyncio
async def test_piper_streams_from_self_hosted_endpoint():
    client = FakeHTTPClient(stream_response=FakeStreamResponse(byte_chunks=[b"wav1", b"wav2"]))
    tts = PiperTTSProvider(
        {"base_url": "http://localhost:5001", "voice": "en_US-lessac-medium"}, http_client=client
    )

    chunks = [c async for c in tts.synthesize_stream("hello", VoiceProfile())]
    assert chunks == [b"wav1", b"wav2"]

    call = client.stream_calls[0]
    assert call["url"] == "http://localhost:5001/synthesize"
    assert call["json"]["voice"] == "en_US-lessac-medium"

    usage = tts.last_usage()
    assert usage.quantity == len("hello")


def test_piper_requires_base_url():
    with pytest.raises(ValueError):
        PiperTTSProvider({})
