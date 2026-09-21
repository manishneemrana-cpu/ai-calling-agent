"""PiperTTSProvider — self-hosted TTS via a local Piper HTTP wrapper.

Economy self-hosted alternate per docs/VERIFICATION.md §3.4.

*** LICENSE CAVEAT — do not ignore, read before deploying this adapter ***
Active Piper development moved to `OHF-Voice/piper1-gpl`, which is
**GPL-3.0** (the original MIT-licensed `rhasspy/piper` repo was archived in
October 2025). GPL-3.0 is copyleft: this adapter talks to Piper over plain
HTTP as an arm's-length, out-of-process service (never imports Piper's
Python code or links its engine into this proprietary codebase) — the
pattern Pipecat itself documents to avoid triggering GPL's source-release
obligations on the *calling* application. That said, this is a legal
question, not a purely technical one, and MUST be reviewed by counsel
before this adapter is used in production for a commercial SaaS. Each
individual Piper voice model also carries its own separate license (some
are personal-use/research-only) and must be checked before selecting it as
a tenant's default voice — see `providers.capabilities.license` for this
provider's row in db/migrations/008_stt_tts_llm_providers.sql, which
repeats this caveat so it surfaces in any admin UI listing providers.

API shape: this adapter assumes a small self-hosted HTTP wrapper (e.g. the
common `POST /` or `POST /synthesize` pattern used by Piper's own
`--http-server` mode / community wrappers) at `config.base_url`, taking
`{"text": str, "voice": str}` and returning the raw audio bytes in the
response body (piped in via `response.aiter_bytes()` for streaming
playback, even though Piper itself is not internally chunked/streaming the
way Sarvam/Cartesia are — the audio is generated up front, then streamed to
the caller in chunks, which still gives incremental playback).

DI: `http_client` injectable, same `httpx.AsyncClient`-shaped `.stream()`
pattern as the ElevenLabs adapter.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import VoiceProfile


class PiperTTSProvider:
    provider_key = "piper"

    def __init__(self, config: dict[str, Any], *, http_client: Any | None = None):
        base_url = config.get("base_url")
        if not base_url:
            raise ValueError("PiperTTSProvider requires config.base_url (self-hosted Piper HTTP wrapper)")
        self._base_url = base_url.rstrip("/")
        self._default_voice = config.get("voice", "en_US-lessac-medium")
        if http_client is None:
            import httpx

            http_client = httpx.AsyncClient()
        self._client = http_client
        self._last_usage: UsageReport | None = None

    async def synthesize_stream(self, text: str, voice_profile: VoiceProfile) -> AsyncIterator[bytes]:
        body = {"text": text, "voice": voice_profile.voice_id or self._default_voice}
        async with self._client.stream("POST", f"{self._base_url}/synthesize", json=body) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes():
                if chunk:
                    yield chunk
        self._last_usage = UsageReport(
            provider_key=self.provider_key, layer="tts", unit="characters", quantity=len(text)
        )

    def last_usage(self) -> UsageReport:
        if self._last_usage is None:
            raise RuntimeError("PiperTTSProvider.last_usage() called before any synthesize_stream()")
        return self._last_usage


register_adapter("tts.piper", lambda config: PiperTTSProvider(config))
