# Provider adapter interfaces (stub contract, Phase 2/3 implements these)

Per `docs/STACK_PROPOSAL.md` §"Adapter interface principle". These are
**illustrative Python `Protocol` shapes only** — not implemented, not
imported anywhere, just the agreed contract so Phase 2/3 has no ambiguity
about the seam between "core pipeline" and "provider-specific code".

```python
from typing import Protocol, AsyncIterator

class TelephonyAdapter(Protocol):
    """One implementation per provider: PlivoTelephonyAdapter (primary),
    ExotelTelephonyAdapter (alternate). Selected at call time from
    agents.telephony_provider_key, never hardcoded."""

    async def place_call(self, to_number: str, from_number: str) -> str:
        """Returns a provider_call_id."""
        ...

    async def answer_call(self, provider_call_id: str) -> None: ...

    async def open_media_stream(self, provider_call_id: str) -> AsyncIterator[bytes]:
        """Bidirectional WebSocket media stream — yields raw audio chunks
        (mulaw/PCM) as they arrive from the caller."""
        ...

    async def hangup(self, provider_call_id: str) -> None: ...

    async def send_dtmf(self, provider_call_id: str, digits: str) -> None: ...


class STTAdapter(Protocol):
    """SarvamSTTAdapter (primary), DeepgramSTTAdapter / GroqWhisperSTTAdapter
    (alternates). Selected from agents.stt_provider_key."""

    async def stream_audio_chunk(self, chunk: bytes) -> AsyncIterator[dict]:
        """Yields partial/final transcript events, e.g.
        {"type": "partial"|"final", "text": str, "confidence": float}."""
        ...


class TTSAdapter(Protocol):
    """SarvamBulbulTTSAdapter (primary), CartesiaTTSAdapter /
    ElevenLabsTTSAdapter / PiperTTSAdapter (alternates). Selected from
    agents.tts_provider_key."""

    async def synthesize_stream(self, text: str) -> AsyncIterator[bytes]:
        """Yields audio chunks as they're synthesized (for low
        time-to-first-audio and barge-in support)."""
        ...


class LLMAdapter(Protocol):
    """GeminiFlashLLMAdapter (primary), GroqLlamaLLMAdapter (alternate).
    Selected from agents.llm_provider_key."""

    async def generate(self, messages: list[dict], tools: list[dict]) -> AsyncIterator[dict]:
        """Yields streamed token/tool-call events."""
        ...
```

## Config resolution (not implemented yet, documented for continuity)

Per call, the orchestrator will resolve each `*_provider_key` on the
`agents` row against `provider_accounts` (per-tenant credentials/config
reference — see `db/migrations/004_billing_providers.sql`) to decide which
concrete adapter class to instantiate. No provider name, model name, price,
phone number, or secret may be hardcoded in this service's source — this is
a repeated, non-negotiable rule from `docs/ARCHITECTURE.md` and the
founder's master prompt.
