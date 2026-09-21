"""STTProvider — the adapter contract every speech-to-text provider
implements. Python realization of the conceptual `STTAdapter` Protocol
sketched in services/voice-gateway/PROVIDERS.md, now actually implemented
(that file's shape was illustrative-only; this is the real interface the
orchestrator imports).

Business/orchestrator code must depend ONLY on this Protocol, obtained via
`voice_gateway.registry.get_provider("stt", ...)` — never import a concrete
adapter class directly, never branch on provider_key.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

from ..usage import UsageReport

TranscriptEventType = Literal["partial", "final"]


@dataclass(frozen=True)
class TranscriptEvent:
    type: TranscriptEventType
    text: str
    confidence: float | None = None


@runtime_checkable
class STTProvider(Protocol):
    """Streaming lifecycle: start_stream() once per call/utterance-group,
    feed_audio_chunk() repeatedly as PCM/mulaw bytes arrive, consuming
    yielded TranscriptEvents as they occur, then end_stream() to flush a
    final transcript and get the call's total UsageReport."""

    provider_key: str

    async def start_stream(self, *, sample_rate: int = 8000, language: str | None = None) -> None:
        """Opens the underlying streaming session (a WebSocket for
        Sarvam/Deepgram; a no-op buffering placeholder for the
        chunked/non-streaming Groq Whisper adapter)."""
        ...

    def feed_audio_chunk(self, chunk: bytes) -> AsyncIterator[TranscriptEvent]:
        """Feeds one raw audio chunk in; yields zero or more partial/final
        transcript events as the provider produces them."""
        ...

    async def end_stream(self) -> tuple[TranscriptEvent | None, UsageReport]:
        """Closes the stream, returning the last final transcript (if any
        chunk hadn't yet been finalized) and this stream's usage report."""
        ...
