"""TTSProvider — the adapter contract every text-to-speech provider
implements. Python realization of the conceptual `TTSAdapter` Protocol
sketched in services/voice-gateway/PROVIDERS.md.

Business/orchestrator code must depend ONLY on this Protocol, obtained via
`voice_gateway.registry.get_provider("tts", ...)`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from ..usage import UsageReport


@dataclass(frozen=True)
class VoiceProfile:
    """Per-tenant/per-agent voice selection, resolved from the tenant's
    agent config (never hardcoded) and passed through to whichever adapter
    the registry resolved for this call."""

    voice_id: str | None = None
    speed: float = 1.0
    language: str | None = None


@runtime_checkable
class TTSProvider(Protocol):
    provider_key: str

    def synthesize_stream(self, text: str, voice_profile: VoiceProfile) -> AsyncIterator[bytes]:
        """Yields audio chunks as they're synthesized, for low
        time-to-first-audio and so playback can start (and be interrupted
        on barge-in) before the whole utterance is generated."""
        ...

    def last_usage(self) -> UsageReport:
        """The UsageReport for the most recently completed
        synthesize_stream() call (characters synthesized)."""
        ...
