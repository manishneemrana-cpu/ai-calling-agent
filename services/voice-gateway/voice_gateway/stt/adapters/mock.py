"""MockSTTProvider — deterministic canned transcript, no network calls.

Used for demo mode and the whole test suite so the pipeline/orchestrator can
be built and exercised without live STT credentials — mirrors
apps/web/lib/providers/telephony/adapters/mock.ts's role for Phase 2.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import TranscriptEvent

DEFAULT_CANNED_TRANSCRIPT = "Hi, I am calling about my recent order, can you help me track it?"


class MockSTTProvider:
    provider_key = "mock"

    def __init__(self, config: dict | None = None):
        config = config or {}
        self._canned_transcript: str = config.get("canned_transcript", DEFAULT_CANNED_TRANSCRIPT)
        self._chunks_fed = 0
        self._words = self._canned_transcript.split()
        self._started = False

    async def start_stream(self, *, sample_rate: int = 8000, language: str | None = None) -> None:
        self._started = True
        self._chunks_fed = 0

    async def feed_audio_chunk(self, chunk: bytes) -> AsyncIterator[TranscriptEvent]:
        if not self._started:
            raise RuntimeError("MockSTTProvider.feed_audio_chunk called before start_stream")
        self._chunks_fed += 1
        # Deterministic: each chunk "reveals" one more word as a partial,
        # and the last configured chunk count yields the final. This lets a
        # test assert an exact sequence of events without any real timing.
        word_index = min(self._chunks_fed, len(self._words))
        partial_text = " ".join(self._words[:word_index])
        if word_index >= len(self._words):
            yield TranscriptEvent(type="final", text=self._canned_transcript, confidence=0.99)
        else:
            yield TranscriptEvent(type="partial", text=partial_text, confidence=0.5)

    async def end_stream(self) -> tuple[TranscriptEvent | None, UsageReport]:
        self._started = False
        final = TranscriptEvent(type="final", text=self._canned_transcript, confidence=0.99)
        # Deterministic fake duration: 0.5s per chunk fed, minimum 1s.
        seconds = max(1.0, self._chunks_fed * 0.5)
        usage = UsageReport(provider_key=self.provider_key, layer="stt", unit="seconds", quantity=seconds)
        return final, usage


register_adapter("stt.mock", lambda config: MockSTTProvider(config))
