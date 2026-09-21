import pytest

from voice_gateway.stt.adapters.mock import MockSTTProvider


@pytest.mark.asyncio
async def test_mock_stt_deterministic_transcript():
    stt = MockSTTProvider({"canned_transcript": "hello world"})
    await stt.start_stream()

    events = []
    async for event in stt.feed_audio_chunk(b"\x00" * 10):
        events.append(event)
    assert events[0].type == "partial"
    assert events[0].text == "hello"

    async for event in stt.feed_audio_chunk(b"\x00" * 10):
        events.append(event)
    assert events[-1].type == "final"
    assert events[-1].text == "hello world"

    final, usage = await stt.end_stream()
    assert final.text == "hello world"
    assert usage.provider_key == "mock"
    assert usage.unit == "seconds"
    assert usage.quantity > 0


@pytest.mark.asyncio
async def test_mock_stt_requires_start_stream():
    stt = MockSTTProvider()
    with pytest.raises(RuntimeError):
        async for _ in stt.feed_audio_chunk(b"\x00"):
            pass
