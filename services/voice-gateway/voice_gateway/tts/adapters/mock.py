"""MockTTSProvider — deterministic canned audio (fixed-length silence
frames), no network calls. Used for demo mode and tests."""

from __future__ import annotations

from collections.abc import AsyncIterator

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import TTSProvider, VoiceProfile  # noqa: F401 (Protocol import for clarity)


class MockTTSProvider:
    provider_key = "mock"

    def __init__(self, config: dict | None = None):
        config = config or {}
        self._chunk_size = config.get("chunk_size", 320)  # 40ms of 8kHz mulaw
        self._num_chunks_per_10_chars = config.get("num_chunks_per_10_chars", 1)
        self._last_usage: UsageReport | None = None

    async def synthesize_stream(self, text: str, voice_profile: VoiceProfile) -> AsyncIterator[bytes]:
        num_chunks = max(1, (len(text) // 10) * self._num_chunks_per_10_chars)
        for _ in range(num_chunks):
            # Deterministic "silence" (zeroed mulaw frame) — not real audio,
            # but a stable, inspectable stand-in for a demo/test.
            yield b"\x00" * self._chunk_size
        self._last_usage = UsageReport(
            provider_key=self.provider_key, layer="tts", unit="characters", quantity=len(text)
        )

    def last_usage(self) -> UsageReport:
        if self._last_usage is None:
            raise RuntimeError("MockTTSProvider.last_usage() called before any synthesize_stream()")
        return self._last_usage


register_adapter("tts.mock", lambda config: MockTTSProvider(config))
