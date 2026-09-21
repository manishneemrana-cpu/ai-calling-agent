import pytest

from voice_gateway.tts.adapters.mock import MockTTSProvider
from voice_gateway.tts.types import VoiceProfile


@pytest.mark.asyncio
async def test_mock_tts_yields_deterministic_chunks_and_usage():
    tts = MockTTSProvider()
    chunks = [c async for c in tts.synthesize_stream("hello world", VoiceProfile())]
    assert len(chunks) > 0
    assert all(c == b"\x00" * 320 for c in chunks)
    usage = tts.last_usage()
    assert usage.provider_key == "mock"
    assert usage.unit == "characters"
    assert usage.quantity == len("hello world")


def test_mock_tts_last_usage_before_synth_raises():
    tts = MockTTSProvider()
    with pytest.raises(RuntimeError):
        tts.last_usage()
