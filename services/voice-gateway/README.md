# Voice Gateway (placeholder — Phase 2/3)

This directory is where the real-time, low-latency voice pipeline lands, per
`docs/ARCHITECTURE.md`. **No streaming/telephony logic exists here yet** —
Phase 1 only scaffolds the directory contract so Phase 2/3 has an obvious,
pre-agreed home and does not need to renegotiate repo layout later.

## Why a separate service, and why Python

- **Different runtime from `apps/web`.** `apps/web` is a Next.js/TypeScript
  request-response dashboard + REST API. This service is a persistent,
  streaming, low-latency (sub-200ms round trip) voice pipeline with VAD and
  barge-in — architecturally a different workload with its own dependency
  tree, deployment target, and scaling profile (long-lived WebSocket
  connections vs. HTTP request/response).
- **Python, via Pipecat** (see `docs/STACK_PROPOSAL.md`): Pipecat has
  first-party Plivo and Exotel serializers/transports already, and the
  STT/TTS/LLM streaming ecosystem is most mature in Python.
- **No shared `node_modules`, no shared build step with `apps/web`.** This
  keeps the option open to extract this into its own repository later
  (see `docs/ARCHITECTURE.md`'s "when to split into a separate repo"
  section) via a simple subtree/filter-repo extraction, without having
  entangled the two services.

## Hard rule (repeated from docs/ARCHITECTURE.md — do not violate in Phase 2/3)

**Real-time call audio must never route through n8n or any other
workflow-automation tool.** This service talks to n8n (when introduced)
only via asynchronous, non-audio events/webhooks (e.g. "call ended, here's
the transcript summary") — never by piping PCM/mulaw audio frames through
it. n8n is for orchestrating what happens *around* a call, never anything
in the live audio path.

## What lands here in Phase 2/3

- A `TelephonyAdapter` interface with a Plivo implementation (primary) and
  an Exotel implementation (alternate) — `place_call`, `answer_call`,
  `open_media_stream`, `hangup`, `send_dtmf`.
- An `STTAdapter` interface with a Sarvam implementation (primary) and
  Deepgram / Groq Whisper implementations (alternates).
- A `TTSAdapter` interface with a Sarvam Bulbul implementation (primary)
  and Cartesia / ElevenLabs / Piper implementations (alternates).
- An `LLMAdapter` interface with a Gemini Flash-Lite/Flash implementation
  (primary) and a Groq Llama implementation (alternate).
- The Pipecat pipeline wiring: VAD → streaming STT → streaming LLM →
  streaming TTS, with barge-in.
- The Conversation Orchestrator: reads a tenant's `agent_prompts` config
  (see `apps/web`'s schema — same Postgres database, this service connects
  to it directly, tenant-scoped the same way the web app is) and drives the
  call from it. This service's core code must never branch on an industry
  name — see `docs/ARCHITECTURE.md`.

See `PROVIDERS.md` in this directory for the concrete adapter interface
stubs (Python `Protocol` definitions, no implementation) that Phase 2/3
will fill in.

## What does NOT land here

- Any vertical-specific business logic (that's tenant `agent_prompts`
  config, read at call time).
- Provider selection hardcoded in code — every adapter is chosen per
  tenant/tier from config (`agents.telephony_provider_key`,
  `stt_provider_key`, `tts_provider_key`, `llm_provider_key` — see
  `db/migrations/003_agents_leads_calls.sql`), resolved against
  `provider_accounts` / `provider_rate_cards`.
