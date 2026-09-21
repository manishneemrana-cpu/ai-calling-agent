"""MediaStreamFrameAdapter — the per-provider WebSocket frame contract.

Same Provider Registry shape as STTProvider/TTSProvider/LLMProvider
(docs/PROVIDER_REGISTRY.md): a `Protocol`, implementations self-register via
`voice_gateway.adapter_map.register_adapter("media_stream.<provider_key>",
factory)`, and callers (`server.py`) resolve one via
`resolve_adapter_factory()` — never importing a concrete adapter class or
branching on provider_key.

Reusing the SAME adapter_map/registry module as every other layer (rather
than inventing a parallel mechanism) is a deliberate architecture choice —
see docs/AUDIO_BRIDGE.md's "Why one adapter map, not a new one" section.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .types import MediaStreamEvent


@runtime_checkable
class MediaStreamFrameAdapter(Protocol):
    """One instance per WebSocket connection (some providers, e.g. FreJun
    Teler's outbound `chunk_id`, need per-connection sequence state)."""

    provider_key: str
    codec: str
    sample_rate: int

    def parse_inbound(self, raw_message: str) -> MediaStreamEvent:
        """Decodes one raw text WebSocket message from the provider into the
        internal, provider-agnostic `MediaStreamEvent` shape."""
        ...

    def encode_outbound_audio(self, pcm: bytes) -> str:
        """Encodes a chunk of synthesized (TTS) audio, already in this
        adapter's `codec`/`sample_rate`, into the exact JSON text message
        this provider expects to receive on the same WebSocket to play it to
        the caller."""
        ...

    def encode_clear(self) -> str | None:
        """Encodes a "stop/clear buffered playback audio" control message,
        for barge-in (the caller starts speaking while the agent's TTS is
        still playing) — see `BargeInController` in
        `voice_gateway/orchestrator/barge_in.py`. Returns `None` if this
        provider has no such documented mechanism (the bridge then falls
        back to simply stopping sending further audio chunks, which still
        stops new speech but cannot flush audio already buffered on the
        provider's side — see docs/AUDIO_BRIDGE.md's "what still needs a
        live account to verify" list)."""
        ...
