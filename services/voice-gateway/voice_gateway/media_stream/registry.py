"""Resolves a `media_stream.<provider_key>` frame adapter — the audio-bridge
analogue of `voice_gateway/registry.py`'s `get_provider()`. Kept as its own
thin function (rather than extending `get_provider` to a `"media_stream"`
layer) because frame adapters are not `tenant_provider_config` rows: which
telephony vendor a call uses is already decided by `calls.provider_call_id`'s
owning row / the webhook's `providerKey`, not a second per-tenant choice —
see docs/AUDIO_BRIDGE.md.

Importing every built-in media-stream adapter module here (for its
self-registering side effect) is the same one-file-knows-the-list pattern
`voice_gateway/registry.py` uses for stt/tts/llm.
"""

from __future__ import annotations

from typing import Any

from ..adapter_map import resolve_adapter_factory
from .adapters import frejun_teler as _frejun_teler  # noqa: F401
from .adapters import plivo as _plivo  # noqa: F401
from .frame_adapter import MediaStreamFrameAdapter


class MediaStreamProviderNotSupportedError(Exception):
    def __init__(self, provider_key: str):
        super().__init__(
            f'No media-stream frame adapter registered for provider "{provider_key}" — '
            "is its module imported in voice_gateway/media_stream/registry.py?"
        )


def resolve_media_stream_adapter(
    provider_key: str, config: dict[str, Any] | None = None
) -> MediaStreamFrameAdapter:
    factory = resolve_adapter_factory(f"media_stream.{provider_key}")
    if factory is None:
        raise MediaStreamProviderNotSupportedError(provider_key)
    return factory(config or {})
