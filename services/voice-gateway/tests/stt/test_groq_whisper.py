import pytest

from tests.fakes import FakeHTTPClient, FakeJSONResponse
from voice_gateway.stt.adapters.groq_whisper import GroqWhisperSTTProvider


@pytest.mark.asyncio
async def test_groq_whisper_buffers_then_transcribes_on_end_stream():
    client = FakeHTTPClient(post_response=FakeJSONResponse({"text": "buffered transcript"}))
    stt = GroqWhisperSTTProvider({"api_key": "fake_groq_key"}, http_client=client)

    await stt.start_stream(sample_rate=8000)
    # No partials — chunked/near-real-time only, never a live socket.
    events = [e async for e in stt.feed_audio_chunk(b"\x00" * 800)]
    assert events == []
    assert client.post_calls == []  # nothing sent yet, still buffering

    final, usage = await stt.end_stream()
    assert final.type == "final"
    assert final.text == "buffered transcript"
    assert usage.provider_key == "groq_whisper"
    assert usage.quantity == pytest.approx(0.1)  # 800 bytes / 8000 Hz

    call = client.post_calls[0]
    assert call["data"]["model"] == "whisper-large-v3-turbo"
    assert call["headers"]["Authorization"] == "Bearer fake_groq_key"


@pytest.mark.asyncio
async def test_groq_whisper_empty_buffer_yields_nothing():
    client = FakeHTTPClient()
    stt = GroqWhisperSTTProvider({"api_key": "fake_groq_key"}, http_client=client)
    await stt.start_stream()
    final, usage = await stt.end_stream()
    assert final is None
    assert usage.quantity == 0
    assert client.post_calls == []


def test_groq_whisper_requires_api_key():
    with pytest.raises(ValueError):
        GroqWhisperSTTProvider({})
