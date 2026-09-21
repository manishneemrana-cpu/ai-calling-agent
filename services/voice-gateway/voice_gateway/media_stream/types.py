"""Provider-agnostic internal frame representation for the audio bridge.

Every provider's WebSocket media-stream adapter (`adapters/plivo.py`,
`adapters/frejun_teler.py`) parses that provider's own JSON message shape
into a `MediaStreamEvent` and encodes outbound TTS audio via
`MediaStreamFrameAdapter.encode_outbound_audio()` back into that provider's
own shape — nothing above the adapter layer (server.py, the orchestrator)
ever sees a provider-specific field name.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

MediaStreamEventKind = Literal["start", "media", "dtmf", "stop", "interruption", "unknown"]


@dataclass(frozen=True)
class MediaStreamEvent:
    kind: MediaStreamEventKind
    """Decoded raw audio bytes for a `media` event (already base64-decoded);
    `None` for every other event kind."""
    audio: bytes | None = None
    """DTMF digit for a `dtmf` event."""
    digit: str | None = None
    """Provider's own stream/call identifier, when the message carries one —
    useful for logging/debugging, never required for correctness (the
    WebSocket connection itself is already scoped to one call_id by the
    server's routing, per docs/AUDIO_BRIDGE.md)."""
    stream_id: str | None = None
    raw: dict[str, Any] | None = None
