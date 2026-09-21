# Voice Gateway (Phase 3 — implemented)

Real-time streaming voice pipeline: multi-provider STT/TTS/LLM adapters
(mirroring Phase 2's telephony Provider Registry pattern) plus a minimal
conversation orchestrator with barge-in and silence handling. See
`docs/ARCHITECTURE.md` (repo root) for why this is a separate Python
service instead of living inside `apps/web`.

## Why a separate service, and why Python

- **Different runtime from `apps/web`.** `apps/web` is a Next.js/TypeScript
  request-response dashboard + REST API. This service is (eventually) a
  persistent, streaming, low-latency voice pipeline with VAD and barge-in —
  a different workload with its own dependency tree and scaling profile.
- **Python**, per `docs/STACK_PROPOSAL.md`'s Pipecat recommendation — the
  STT/TTS/LLM streaming ecosystem is most mature in Python.
- **No shared `node_modules`, no shared build step with `apps/web`.**
- **Same Postgres database as `apps/web`** — this is a two-runtime, one-database
  repo. `voice_gateway/registry.py` and `voice_gateway/db.py` connect to the
  exact same `providers` / `tenant_provider_config` tables Phase 2's
  `db/migrations/007_provider_registry.sql` created (no schema duplication),
  using the same Row-Level-Security tenant-isolation contract
  (`app.current_org_id` via `SET LOCAL`) as `apps/web/lib/db/tenant.ts`.

## Hard rule (repeated from docs/ARCHITECTURE.md)

**Real-time call audio must never route through n8n or any other
workflow-automation tool.**

## What's implemented (Phase 3)

- **Provider Registry, Python side** (`voice_gateway/registry.py` +
  `voice_gateway/adapter_map.py`): the identical "zero if/else, add a row +
  a class" contract as Phase 2's TypeScript registry
  (`docs/PROVIDER_REGISTRY.md`), now covering `stt`/`tts`/`llm` — no schema
  change, only new `providers` catalog rows
  (`db/migrations/008_stt_tts_llm_providers.sql`).
- **STT adapters** (`voice_gateway/stt/adapters/`): `mock`, `sarvam`
  (Saaras v3-realtime streaming WebSocket), `deepgram` (Nova-3 streaming
  WebSocket), `groq_whisper` (whisper-large-v3-turbo, chunked/near-real-time
  REST — Groq's hosted Whisper has no native streaming socket).
- **TTS adapters** (`voice_gateway/tts/adapters/`): `mock`, `sarvam`
  (Bulbul v3 streaming WebSocket), `cartesia` (Sonic-3 streaming WebSocket),
  `elevenlabs` (HTTP streaming), `piper` (self-hosted HTTP — **GPL-3.0
  license caveat, read the module docstring before deploying this one**).
- **LLM adapters** (`voice_gateway/llm/adapters/`): `mock` (including a
  fake tool-call, for exercising the orchestrator's tool-dispatch path),
  `gemini` (streaming + tool-calling via `streamGenerateContent` SSE,
  serving both `llm.gemini_flash_lite` and `llm.gemini_flash` catalog rows),
  `groq_llama` (streaming + tool-calling via the OpenAI-compatible
  `/chat/completions` endpoint, `llama-3.1-8b-instant`).
- **Orchestrator** (`voice_gateway/orchestrator/`): `ConversationOrchestrator`
  wires STT → LLM (with tool dispatch) → TTS; `BargeInController` interrupts
  in-flight TTS playback; `SilenceMonitor` implements the 2s/5s/10s
  wait/prompt/end-call escalation ladder as a directly-testable, pure state
  machine (`tick(now)`), plus an async polling loop for production use.
- **Latency instrumentation** (`voice_gateway/latency.py`): structured
  (JSON) logging of end-of-speech → transcript → LLM-first-token →
  first-TTS-byte, per turn.
- **Tests**: one file per adapter (mocked HTTP/WebSocket clients — request
  shape, streaming parse, error handling), a registry "add a provider with
  zero changes to existing code" proof, an all-mock end-to-end pipeline
  test (transcript → tool call → reply → TTS, barge-in, silence escalation),
  and a Python-side tenant-isolation proof for the new `stt`/`tts`/`llm`
  `tenant_provider_config` rows.

## Model-name / pricing re-verification (2026-09-21)

The spec's originally-named models had already started deprecating by the
time this phase started (see `docs/VERIFICATION.md`'s dated appendix,
written *before* this phase, for the full research). This phase's adapters
follow that appendix's conclusions directly:

- **Gemini**: targets Google's own rolling aliases `gemini-flash-lite-latest`
  / `gemini-flash-latest` instead of a dated model string, specifically so
  the 2026-10-16 retirement of Gemini 2.5 Flash-Lite/Flash (and any future
  retirement) doesn't require another code change. A tenant needing a
  pinned model for cost-contract stability can still override `config.model`.
- **Groq Llama**: targets `llama-3.1-8b-instant` (still self-serve) instead
  of `llama-3.3-70b` (moved to enterprise-only "contact sales" pricing
  2026-08-26).
- **Sarvam STT**: targets `saaras:v3-realtime` (the current realtime
  streaming model), not the older Saarika v2.5 batch model.

## Deferred / follow-up work (scoped out of this phase, on purpose)

- **Real Pipecat `Pipeline`/`Transport` wiring.** This phase implements the
  orchestrator's control-flow contract (barge-in interrupt, silence
  escalation, STT→LLM→TTS wiring) as directly-testable Python classes
  driven by an in-process `AsyncIterator[bytes]`, per the task's own scoping
  allowance ("does NOT need real telephony audio yet... local audio
  loopback / WebSocket test harness... demonstrable without a live phone
  call"). Wiring `ConversationOrchestrator` into an actual Pipecat
  `Pipeline` with `SileroVADAnalyzer`-driven `VADParams` against a live
  audio transport is real, scoped-out follow-up work — see
  `voice_gateway/orchestrator/barge_in.py`'s docstring for exactly where
  that wiring plugs in (`BargeInController.trigger()`) without needing to
  change anything else in this module.
- **Telephony ↔ voice-gateway wiring.** Phase 2's Plivo/FreJun Teler
  telephony adapters (`apps/web/lib/providers/telephony/`) are not yet
  connected to this service's media path — that's the natural Phase 3.5/4
  follow-up (a live call's `streamAudio()` WebSocket needs to land in this
  process and feed `ConversationOrchestrator.run_turn()`'s audio-chunk
  iterator instead of a test's fake generator).
- **`usage_records`/`cost_records` end-to-end wiring.** Every adapter
  already returns a real `UsageReport` (seconds/characters/tokens — see
  `voice_gateway/usage.py`), but nothing yet `INSERT`s those into the
  existing `usage_records`/`cost_records` tables
  (`db/migrations/004_billing_providers.sql`, unchanged). That's a
  call-lifecycle/billing-service integration decision (needs org_id/call_id
  threaded through every adapter call site) that belongs with a dedicated
  usage-writer, not bolted onto each adapter — deferred so it can be done
  once, correctly, against real call data instead of per-adapter guesswork.
- **Piper's GPL-3.0 licensing** needs a counsel review before production use
  — see `voice_gateway/tts/adapters/piper.py`'s docstring and
  `db/migrations/008_stt_tts_llm_providers.sql`'s `providers.capabilities`
  row for this provider, both of which repeat the caveat so it can't be
  missed by only reading one of them.

## Running standalone

Requires Python 3.11+ and (for the registry/tenant-isolation tests) a local
Postgres with Phase 1/2/3's migrations applied — see the root README's
Quickstart.

```bash
cd services/voice-gateway

# 1. Create a virtualenv and install (runtime + dev/test deps)
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# 2. Configure env vars (see the root .env.example's "Phase 3" section)
cp ../../.env.example .env   # edit if your local Postgres differs
export DATABASE_URL="postgresql://app_user:app_user_dev_password@localhost:5432/ai_calling_agent"
export DATABASE_URL_MIGRATE="postgresql://postgres:postgres@localhost:5432/ai_calling_agent"
export PROVIDER_CONFIG_ENCRYPTION_KEY="dev-only-change-me-32-bytes-minimum"  # must match apps/web's

# 3. Run the mock end-to-end pipeline demo (no DB, no network, no API keys needed)
python -m voice_gateway.demo

# 4. Run the test suite (unit tests always run; the registry/tenant-isolation
#    integration tests auto-skip if no Postgres is reachable)
python -m pytest -q

# 5. Lint/format
ruff check .
ruff format --check .
```

### Why `pyproject.toml` and not `requirements.txt`

One file (PEP 621) covers both runtime and dev/test dependencies — the
Python-project equivalent of `apps/web`'s single `package.json`. A
`requirements.txt` would just duplicate the same dependency list with no
extra capability this project currently needs.

## Structure

```
voice_gateway/
  registry.py, adapter_map.py, crypto.py, db.py, usage.py, latency.py
  stt/{types.py, adapters/{mock,sarvam,deepgram,groq_whisper}.py}
  tts/{types.py, adapters/{mock,sarvam,cartesia,elevenlabs,piper}.py}
  llm/{types.py, adapters/{mock,gemini,groq_llama}.py}
  orchestrator/{pipeline.py, barge_in.py, silence.py}
  demo.py
tests/   # mirrors voice_gateway/'s structure, plus test_registry.py,
         # test_tenant_isolation.py, test_pipeline_e2e.py, test_crypto.py
```

See `PROVIDERS.md` in this directory for the original Phase 2/3 adapter
interface contract this phase implements.
