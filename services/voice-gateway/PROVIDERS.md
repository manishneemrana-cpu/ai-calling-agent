# Provider adapter interfaces (Phase 3 status: implemented for stt/tts/llm)

Per `docs/STACK_PROPOSAL.md` §"Adapter interface principle". The shapes
below were **illustrative-only** when this file was first written in
Phase 1/2. Phase 3 has since implemented the STT/TTS/LLM contracts for
real, as `voice_gateway/{stt,tts,llm}/types.py` — the actual `Protocol`s
the orchestrator (`voice_gateway/orchestrator/pipeline.py`) imports and
calls, which differ in a few details from the sketch below (e.g.
`STTProvider` is a streaming lifecycle of
`start_stream`/`feed_audio_chunk`/`end_stream` rather than one
`stream_audio_chunk` method, and every provider call returns a
`UsageReport` for cost accounting). The `TelephonyAdapter` sketch below
remains purely illustrative — telephony audio is not yet wired into this
service, see `README.md`'s "Deferred / follow-up work".

```python
from typing import Protocol, AsyncIterator


class TelephonyAdapter(Protocol):
    """One implementation per provider. Per the 2026-09-21 telephony research
    (docs/VERIFICATION.md §7, docs/STACK_PROPOSAL.md's ranked telephony list),
    Phase 2 will implement the top-ranked 2-3 of these confirmed
    streaming-capable providers, cheapest-first:

      1. FreJunTelerTelephonyAdapter (recommended starting default — cheapest
         verified, streaming-confirmed option, ~₹0.28-0.30/min; newer/smaller
         brand, needs a paid pilot before full production trust)
      2. PlivoTelephonyAdapter (fallback/alternate — most mainstream,
         best-documented, first-party Pipecat serializer, ~₹0.95/min)
      3. ExotelTelephonyAdapter (alternate — streaming-confirmed via
         AgentStream, pricing is sales-quote-only)
      4. TataSmartfloTelephonyAdapter (alternate — streaming-confirmed
         directly from Tata's own developer docs, pricing sales-quote-only,
         backed by a licensed telecom operator)
      5. AcefoneTelephonyAdapter (alternate — streaming-confirmed via
         Acefone's own Voice Streaming API/SOP docs; Servetel is a reseller
         brand of this platform; pricing sales-quote-only)
      6. OzonetelTelephonyAdapter (watch — plausible streaming support via
         partner signals, e.g. its own ElevenLabs integration, but not
         confirmed from Ozonetel's own technical docs; needs a hands-on spike
         before implementation)
      7. TwilioTelephonyAdapter (global-fallback/comparison — streaming
         confirmed, but not India-optimized: no India-specific DLT/DND
         tooling, USD-denominated billing)

    Explicitly NOT planned as adapters (excluded — no confirmed real-time
    bidirectional audio streaming, only IVR/recording/call-flow APIs found):
    Knowlarity (SuperReceptionist), Airtel IQ, MyOperator. Direct SIP
    trunking (Airtel Business / Jio / Tata Communications / BSNL) is
    enterprise-only (no self-serve signup) and not viable at this stage.
    Kaleyra/Route Mobile/Karix were skipped: no findable public per-minute
    India voice-streaming pricing.

    Selected at call time from agents.telephony_provider_key, never
    hardcoded."""

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

## Why the `TelephonyAdapter` interface must stay provider-agnostic

The 2026-09-21 telephony research (`docs/VERIFICATION.md` §7) is a direct
illustration of why this interface cannot collapse to "just implement
Plivo": the cheapest verified streaming-capable option changed within a
single research pass (Plivo's long-assumed default position was displaced by
FreJun Teler on cost, while Exotel/Tata Smartflo/Acefone all turned out to
be equally streaming-capable, just pricing-unconfirmed). Relative
provider rankings in India's cloud-telephony market are volatile — new
entrants, pricing changes, and DLT/DND tooling differences can reorder the
"cheapest viable" list again before Phase 2 even ships. On top of that, a
specific tenant or white-label reseller may already hold a negotiated
contract with a specific provider (e.g. an existing Tata Tele or Airtel
relationship) that makes it the right choice for that tenant regardless of
this document's ranking. The adapter interface exists precisely so that
today's ranking is a config default, never a code dependency — Phase 2
implementing 2-3 adapters now does not close the door on adding FreJun
Teler, Ozonetel, or any other provider later without touching the core
pipeline.
