# Audio Bridge — Phase 3.5 (telephony ↔ voice-gateway)

Status: implemented for Plivo and FreJun Teler's documented WebSocket media
formats, unit/integration-tested against a simulated provider client. **Not
yet smoke-tested against a live phone call** — see "What still needs a live
account to verify" below. This document also covers Part B (usage/cost
wiring) and Part C (knowledge-base/RAG guardrail scaffold), which shipped
alongside the bridge in the same phase.

## Why this document exists

Phase 3's README ("Deferred / follow-up work") named this exact gap:
Phase 2's Plivo/FreJun Teler telephony adapters (`apps/web`) could create a
call, but nothing connected a live call's audio to Phase 3's
`ConversationOrchestrator` (`services/voice-gateway`). This phase closes
that gap as far as possible without live provider credentials.

## Architecture

```
                         apps/web (Next.js, Node/TS)
  ┌─────────────────────────────────────────────────────────────────┐
  │  POST /api/calls  ──► TelephonyProvider.createCall()             │
  │                                                                   │
  │  Plivo/FreJun webhook ──► POST /api/calls/webhook/[providerKey]  │
  │     │                       │                                    │
  │     │            process_telephony_webhook_event()               │
  │     │            (idempotent, existing Phase 2 function)         │
  │     │                       │                                    │
  │     └── status == 'in_progress' (was_new) ──► notifyCallAnswered()│
  │                              │  (lib/voice-gateway/client.ts)     │
  └──────────────────────────────┼───────────────────────────────────┘
                                  │  POST /internal/pipelines/{callId}/start
                                  │  { orgId, userId, providerKey }
                                  ▼
                    services/voice-gateway (Python)
  ┌─────────────────────────────────────────────────────────────────┐
  │  internal_api.handle_start_pipeline_request()                    │
  │      │                                                            │
  │      ▼                                                            │
  │  PipelineManager.start_pipeline(callId, orgId)                    │
  │      - resolves stt/tts/llm via registry.get_provider()           │
  │        (same Provider Registry every other layer uses)            │
  │      - stashes them, keyed by callId                              │
  └─────────────────────────────────────────────────────────────────┘
                                  │
                                  │  (meanwhile, the telephony provider's
                                  │   own <Stream>/flow config opens a
                                  │   WebSocket to this service)
                                  ▼
              /media-stream/{call_id}?provider={plivo|frejun_teler}
  ┌─────────────────────────────────────────────────────────────────┐
  │  server.handle_media_stream(ws, call_id, provider_key, manager)   │
  │      │                                                            │
  │      ▼                                                            │
  │  media_stream.registry.resolve_media_stream_adapter(provider_key) │
  │      → PlivoMediaStreamAdapter | FreJunTelerMediaStreamAdapter    │
  │      │  .parse_inbound(raw_json) → MediaStreamEvent               │
  │      │  .encode_outbound_audio(pcm) → raw_json                    │
  │      │  .encode_clear() → raw_json | None  (barge-in)             │
  │      ▼                                                            │
  │  PipelineManager.get_orchestrator(call_id)                        │
  │      → ConversationOrchestrator.run_turn(audio_frames)             │
  │         (the EXACT Phase 3 orchestrator — STT → LLM (+ RAG         │
  │          grounding, Part C) → TTS, barge-in, silence handling)     │
  └─────────────────────────────────────────────────────────────────┘
```

## Why a per-provider frame adapter, not one shared parser

Plivo and FreJun Teler's WebSocket messages are genuinely different wire
protocols, not just field-name variants of the same shape:

|                  | Plivo                                   | FreJun Teler                     |
|------------------|------------------------------------------|-----------------------------------|
| Message key      | `"event"`: `start`/`media`/`dtmf`/`stop`  | `"type"`: `audio`/`interruption`  |
| Inbound audio    | `media.payload` (base64), nested         | `data.audio_b64` (base64)         |
| Outbound audio   | `{"event":"playAudio","media":{...}}`     | `{"type":"audio","audio_b64":...,"chunk_id":N}` |
| Codec            | `audio/x-mulaw` @ 8000 Hz mono            | L16 (raw PCM) @ 8000 Hz            |
| Barge-in/clear   | `{"event":"clearAudio"}` (documented)     | **not documented** (see below)     |

Given that, the cleanest design was a small per-provider adapter
(`voice_gateway/media_stream/adapters/{plivo,frejun_teler}.py`) implementing
one shared `MediaStreamFrameAdapter` Protocol
(`voice_gateway/media_stream/frame_adapter.py`), resolved through the SAME
self-registering `adapter_map`/registry pattern every other layer already
uses (`voice_gateway/media_stream/registry.py`) — rather than either (a)
one shared parser with if/else branches on provider_key (violates the
project's zero-branching Provider Registry contract), or (b) normalizing
frames inside `apps/web`'s telephony adapter before forwarding (rejected:
`apps/web` never touches live call audio at all today — Plivo/FreJun open
their media WebSocket directly to the voice-gateway process, not through
Next.js — and routing audio through a second Node hop would add latency for
no benefit, plus violate `docs/ARCHITECTURE.md`'s existing hard rule that
real-time call audio must go straight to the voice pipeline).

## Verified frame formats (sources, with dates)

Direct `WebFetch` to `plivo.com`, `docs.pipecat.ai`, and `medium.com` was
blocked by this environment's egress proxy — the same constraint
`docs/VERIFICATION.md`'s own Plivo research hit. Findings below are from
`WebSearch` snippets, cross-checked across multiple independent sources
(not a single guess), all captured 2026-09-21.

**Plivo** (`voice_gateway/media_stream/adapters/plivo.py`'s docstring has
the full field-by-field breakdown):
- Audio: `audio/x-mulaw` @ 8000 Hz mono, base64 chunks.
- Inbound: `start` / `media` / `dtmf` / `stop`, keyed by `"event"`.
- Outbound: `playAudio` (play audio), `clearAudio` (documented barge-in —
  "clears all buffered media events"), `checkpoint` (playback-progress
  marker, not used by this bridge yet).
- Sources: Plivo's own "Audio Streaming Guide"
  (plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-guide),
  Plivo's Java Streaming SDK (github.com/plivo/plivo-stream-sdk-java),
  Plivo support article on `clearAudio`
  (support.plivo.com/hc/en-us/articles/32800291247001).

**FreJun Teler** (`voice_gateway/media_stream/adapters/frejun_teler.py`'s
docstring has the full breakdown):
- Audio: raw L16 PCM @ 8000 Hz, base64, configurable chunk size (their own
  sample: 400 bytes).
- Inbound: `{"type": "audio", "data": {"audio_b64": ...}}`, plus an
  `{"type": "interruption"}` barge-in signal.
- Outbound: `{"type": "audio", "audio_b64": ..., "chunk_id": N}`.
- Sources: `github.com/frejun-tech/teler-py`'s README sample code (fetched
  directly), `frejun.ai`'s "How Can a Voice API for Developers Handle
  Real-Time Audio Streaming?" page (search snippet).
- **Documentation gap, called out explicitly**: no FreJun Teler
  `"clearAudio"`-equivalent outbound message was found anywhere in this
  research. `FreJunTelerMediaStreamAdapter.encode_clear()` returns `None`
  for this reason — barge-in on this provider can stop sending FURTHER
  audio chunks but cannot flush audio already buffered on Teler's own side.

## What's implemented and tested (no live account needed)

- `voice_gateway/media_stream/` — frame types, the `MediaStreamFrameAdapter`
  Protocol, both providers' adapters, `PipelineManager`, `server.py`'s
  `handle_media_stream()`, and `internal_api.py`'s
  `handle_start_pipeline_request()`.
- `apps/web/lib/voice-gateway/client.ts` — `notifyCallAnswered()`, wired into
  `app/api/calls/webhook/[providerKey]/route.ts`.
- Tests (`services/voice-gateway/tests/media_stream/`):
  - `test_plivo_media_stream.py` — a fake client sends Plivo's real
    documented `start`/`media`/`stop` JSON at `handle_media_stream()`;
    proves audio decodes correctly, MockSTT/MockLLM produce a reply, and
    the outbound audio is correctly Plivo-framed (`playAudio`,
    `audio/x-mulaw`, base64).
  - `test_frejun_teler_media_stream.py` — same proof for FreJun Teler's
    different `type`-keyed JSON shape, plus its `interruption` message
    triggering the barge-in callback.
  - `test_pipeline_manager.py` / `test_internal_api.py` — the "call
    answered" trigger path, using MockTelephony-shaped payloads and real
    `tenant_provider_config` rows (no live telephony account).
  - `apps/web/tests/voice-gateway/call-answered-wiring.test.ts` — proves
    the webhook route actually calls `notifyCallAnswered()` exactly once
    per call-answered transition (idempotent on retried webhooks, and a
    voice-gateway outage never fails the webhook's own 200 response).

## What still needs a live account to verify

1. **Actual audio codec compatibility end-to-end** — this bridge decodes/
   encodes the documented byte formats correctly in isolation, but has
   never round-tripped real mulaw/L16 audio through a real Plivo/FreJun
   call and a real STT/TTS vendor to confirm no resampling/encoding
   mismatch exists.
2. **Real network jitter / packet ordering behavior** — the test suite uses
   an in-process fake transport with perfectly-ordered, synchronous
   delivery; a live call's WebSocket can reorder/drop/delay frames in ways
   this bridge has not been hardened against (no jitter buffer implemented
   yet).
3. **FreJun Teler's exact webhook signature scheme** (a pre-existing Phase 2
   gap, repeated here since it blocks the whole call-answered trigger for
   this provider) and its **outbound barge-in/clear message**, if one
   exists — not found in any available documentation (see above).
4. **Plivo's exact `start` event's `mediaFormat` behavior** when a tenant's
   `<Stream>` XML requests `audio/x-l16` instead of mulaw — this adapter
   defaults to mulaw/8kHz per `docs/VERIFICATION.md`, and has not verified
   the L16 path.
5. **Multi-turn continuous conversation over one persistent connection.**
   `handle_media_stream()` currently drives exactly one
   `ConversationOrchestrator.run_turn()` per WebSocket connection (ending on
   the provider's own `stop` event or a closed connection) — matching
   Phase 3's existing single-turn `run_turn()` contract. Real silence-based
   turn-boundary segmentation that calls `run_turn()` repeatedly over one
   live call is real follow-up work.
6. **True concurrent full-duplex barge-in.** This bridge's inbound-frame
   generator and the orchestrator's turn logic run sequentially (feed all
   inbound audio, then produce a reply) — a live call's genuinely
   simultaneous caller-speaks-while-agent-is-talking timing needs the
   reader loop and the TTS-sending loop running as truly concurrent tasks
   (an `asyncio.Queue`-based design), not yet implemented, to be safe to
   test deterministically without a live call's real timing.
7. **A production ASGI/WebSocket server process** — `server.py`'s
   `handle_media_stream()` and `internal_api.py`'s `handle_start_pipeline_request()`
   are framework-agnostic functions (deliberately, for testability); wiring
   them into an actual running `websockets`-based server process (and,
   ideally, replacing `internal_api.py`'s hand-rolled HTTP parser with a
   real ASGI framework once this service needs more than one route) is
   deployment work, not proven by this phase's tests.

## Part B — usage/cost wiring

`voice_gateway/billing/cost_writer.py` is the single writer path from a
call's collected `UsageReport`s (every STT/TTS/LLM adapter already returns
one — `voice_gateway/usage.py`, Phase 3) into `usage_records` +
`cost_records` (`db/migrations/004_billing_providers.sql`, unchanged
schema). `write_usage_and_cost()` writes both rows in one tenant-scoped
transaction, computing `amount_usd` from a `provider_rate_cards` row (never
a hardcoded number) via `compute_cost_usd()` — a pure function, unit-tested
against known numbers with no DB. `write_call_usage()` is the batch
entrypoint a call-lifecycle hook (e.g. `PipelineManager`/`server.py`, at
call end) calls once with every `UsageReport` a call produced.

**Known simplification, noted rather than hidden**: `provider_rate_cards`
(Phase 1 schema) has one `unit_price_usd` per `(provider_type,
provider_key, unit)` — real LLM pricing is actually two rates (input vs.
output tokens). `db/migrations/009_embedding_layer_and_rate_cards.sql`'s
seeded `llm.gemini_flash_lite` row prices only the input-token rate for
this reason; a real go-live billing pass needs either a second rate-card
row convention (e.g. `unit = 'per_1m_input_tokens'` /
`'per_1m_output_tokens'`) or a schema change — flagged here as real
follow-up work, not silently absorbed into one blended number.

Tests: `tests/billing/test_cost_writer.py` — pure math tests, a full
write-path test asserting the persisted `cost_records` row matches expected
math from a seeded rate card, a `RateCardNotFoundError` test (missing rate
card fails loudly, never silently $0), and a tenant-isolation test (org B
can never read org A's usage/cost rows, and can't write a cost row
attributed to org A while scoped as org B — RLS `WITH CHECK` rejects it).

## Part C — knowledge base / RAG guardrail scaffold

New Provider Registry layer, `embedding` — added because the founder's
non-negotiable "no layer ever hardcoded to 1-2 providers" rule applies to
embeddings exactly as much as telephony/STT/TTS/LLM.
`providers.layer`/`tenant_provider_config.layer`'s `CHECK` constraint
**needed a real migration** (`db/migrations/009_embedding_layer_and_rate_cards.sql`,
`ALTER TABLE ... DROP/ADD CONSTRAINT`) to add `'embedding'` — unlike Phase
3's `stt`/`tts`/`llm`, which Phase 2's original `CHECK` had already
anticipated. This is the design working as documented
(`docs/PROVIDER_REGISTRY.md`'s "text + CHECK, not ENUM, so adding a layer
is a one-line CHECK edit"), not a schema regression.

- `embedding.mock` (deterministic hash-based vectors, default) and
  `embedding.gemini` (Google's `text-embedding-004`, 768-dim — chosen
  specifically to match `knowledge_chunks.embedding`'s existing
  `vector(768)` column width with no truncation, and because it's the same
  vendor/API surface the `llm.gemini_*` adapters already use).
- `voice_gateway/knowledge/chunking.py` — pure, whitespace-respecting
  fixed-size chunker with overlap.
- `voice_gateway/knowledge/ingest.py` — chunk + embed (via the registry) +
  insert into `knowledge_documents`/`knowledge_chunks`, tenant-scoped.
  pgvector values are sent as asyncpg has no native `vector` codec — the
  standard workaround, an array-literal string cast with `::vector` in the
  SQL text (`voice_gateway/knowledge/vector_codec.py`).
- `voice_gateway/knowledge/retrieval.py` — pgvector cosine-similarity
  top-k search, RLS-scoped, with a tunable `min_similarity` floor (default
  `0.15`) below which nothing is returned — without this floor,
  `ORDER BY ... LIMIT k` always returns SOMETHING (the least-dissimilar row
  in the tenant's whole KB), even for a completely unrelated query, which
  would defeat the entire point of this feature.
- `voice_gateway/knowledge/grounding.py` — `build_grounded_system_prompt()`,
  an actual testable prompt-construction function: injects retrieved
  chunks as the sole source of business facts, or — when retrieval is
  empty — instructs the LLM with the spec's own example deflection line
  ("Main galat jaankari nahi dena chahta...") instead of guessing.
- Wired into `ConversationOrchestrator` (Phase 3,
  `voice_gateway/orchestrator/pipeline.py`) as an OPTIONAL step: a new
  `base_persona_prompt` + `knowledge_retriever` constructor pair, both
  `None` by default (every existing Phase 3 call site, mock or otherwise,
  behaves identically to before this feature existed) — when both are set,
  each turn's user transcript triggers a fresh retrieval + system-prompt
  rebuild before the LLM is called.

Tests (`services/voice-gateway/tests/knowledge/`): pure chunking tests,
pure grounding-prompt tests (asserting the deflection instruction is
actually present when retrieval is empty, and absent when chunks were
found — not asserting anything about real LLM behavior, which is untestable
without live keys), and a DB-integration suite that ingests a small fake
knowledge base for tenant A and proves relevant-query retrieval, empty
retrieval for an unrelated query, and full tenant isolation (tenant B never
sees tenant A's chunks, even with zero documents of its own).

**Not yet implemented (real follow-up work)**: an actual "is this turn's
question business-fact-shaped" classifier — today, wiring grounding into a
call means the orchestrator retrieves for EVERY turn once both constructor
args are set, not just turns that look like they need a business fact
(e.g. "hi, how are you" would also trigger a retrieval call). A cheap
pre-classification step (or simply accepting the extra embedding-provider
call's low cost/latency at this phase's scale) is a reasonable next
iteration, deferred here to keep this phase's scope to the retrieval/
grounding mechanism itself.
