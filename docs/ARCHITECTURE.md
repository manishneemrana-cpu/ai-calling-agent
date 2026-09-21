# Target Architecture — Phase 0

This describes the target architecture for a **general-purpose, multi-industry AI voice calling platform** — usable for any business vertical (real estate, healthcare/diagnostics, e-commerce/D2C, education, collections, delivery/logistics, insurance, customer support, and others), not hardcoded to any one of them. No application code is written in Phase 0; this is a design document to be validated before Phase 1 build begins.

**Vertical-neutral by design**: nothing in the pipeline, data model, or orchestrator below assumes real estate (or any other vertical). What makes an agent "a real-estate agent" or "a diagnostics-lab agent" is entirely tenant-level **Agent Builder config** — persona, prompt, tools, knowledge base, pipeline stages, disposition set — produced either by hand or by the **Prompt-to-Agent Builder** (see `PROMPT_TO_AGENT_BUILDER.md`). Real estate is the vertical of the founder's own first tenant, configured through that same builder like any other customer, not a special case in the core system.

## High-level flow

```
Caller (PSTN / mobile)
        │
        ▼
Telephony Adapter  (Plivo primary / Exotel alternate — bidirectional WebSocket media stream)
        │  raw audio (mulaw/PCM, base64 chunks over WebSocket)
        ▼
Voice Gateway  (Pipecat pipeline: VAD → streaming STT → streaming LLM → streaming TTS, with barge-in)
        │  STT adapter: Sarvam primary / Deepgram, Groq-Whisper alternates
        │  TTS adapter: Sarvam Bulbul primary / Cartesia, ElevenLabs, Piper alternates
        │  LLM adapter: Gemini Flash-Lite primary / Groq Llama alternate
        ▼
Conversation Orchestrator  (turn management, tool-calling, business logic, guardrails —
        │                    all driven by per-tenant Agent Builder config, vertical-agnostic core)
        │
        ├──► PostgreSQL + pgvector   (tenants, agent_prompts/Agent Builder configs, call transcripts,
        │                             vertical-agnostic CRM/pipeline records, knowledge-base embeddings for RAG tool calls)
        ├──► Redis                   (in-flight call/session state, rate limiting, pub/sub, outbound-call job queue)
        └──► Object storage          (call recordings, transcripts archive — subject to retention/consent policy, see COMPLIANCE.md)
        │
        ▼
CRM / API layer  (tenant-facing REST/GraphQL API, webhooks, reseller/white-label admin)
        │
        ├──► n8n control-plane  (workflow orchestration for NON-real-time tasks only — lead sync, CRM updates,
        │                        WhatsApp template dispatch, scheduling, reporting. n8n NEVER touches live call audio.)
        │
        └──► WhatsApp Adapter  (post-call follow-up, site-visit confirmations, document sharing — separate channel from voice)
```

## Hard architectural rule: real-time call audio must never route through n8n

n8n is a workflow-automation control-plane tool, not a real-time media system. It is well-suited to orchestrating *what happens around* a call (CRM sync, lead scoring, follow-up sequencing, WhatsApp messages, reporting dashboards) but is architecturally wrong for anything in the live audio path: it cannot meet the sub-200ms round-trip latency budget a barge-in-capable voice agent needs, and routing PCM/mulaw audio through a generic workflow engine would be both slow and an unnecessary compliance/security surface (call audio is sensitive data). **The voice gateway and orchestrator therefore talk to n8n only via asynchronous, non-audio events/webhooks (e.g., "call ended, here's the transcript summary and lead status") — never by piping live audio frames through it.**

## Component responsibilities

- **Telephony Adapter**: thin per-provider implementation of `place_call / answer_call / open_media_stream / hangup / send_dtmf`, hiding Plivo's `<Stream bidirectional>` XML/WebSocket contract or Exotel's AgentStream WebSocket contract behind one interface (see STACK_PROPOSAL.md).
- **Voice Gateway**: the real-time pipeline — voice activity detection (VAD), streaming STT, streaming LLM (with partial-response handling), streaming TTS, and barge-in (caller interrupts agent mid-sentence, playback stops, new input is processed). Built on Pipecat, itself provider-agnostic per adapter.
- **Conversation Orchestrator**: holds the conversation state machine and a **vertical-agnostic core** — it reads a tenant's Agent Builder config (persona, prompt, qualification questions, objection-handling stubs, pipeline stages, disposition set) and its declared tool set at call time, rather than having any vertical's logic hardcoded. Tools are generic capabilities the config wires up per tenant — e.g. "check availability," "book an appointment/site visit," "look up an order/case status," "check eligibility/pricing" — which may call out to vertical-specific systems (for the founder's own real-estate tenant, that includes this repo's existing SitesNSign AI Executive skill roster, e.g. Home Loan/EMI Agent, Site Visit Coordinator, via internal API; other tenants wire the same tool slots to their own systems). Safety/compliance guardrails (e.g., refusing to place a call to a DND-registered number, enforcing consent windows) are tenant-config-driven but enforced by the shared core, not duplicated per vertical.
- **PostgreSQL + pgvector**: system of record for tenants, `agent_prompts`/Agent Builder configs (including ones produced by the Prompt-to-Agent Builder), call logs, transcripts, a vertical-agnostic CRM/lead-pipeline schema (tenant-defined stages and dispositions, not a fixed real-estate funnel), and vector embeddings for retrieval-augmented responses (e.g., a tenant's product catalog, property listings, FAQ knowledge base — whatever that tenant's knowledge-base scaffold contains).
- **Redis**: low-latency session/session-state store during an active call, plus the outbound-dialing job queue and pub/sub between gateway and orchestrator processes.
- **CRM/API layer**: the tenant- and reseller-facing surface — dashboards, white-label configuration, billing/usage metering, webhook delivery.
- **n8n control-plane**: business-process automation around calls (never inside them) — e.g., "on call-ended webhook, update CRM, send WhatsApp follow-up, notify a human if lead is hot."
- **WhatsApp Adapter**: a separate channel adapter for text/template messaging (site-visit confirmations, document links, opt-in messages), decoupled from the voice pipeline.

## Where this service lives in the repo (decision + reasoning)

**Recommendation: a new, separate top-level directory (`voice-agent-platform/`) in this same repo, structured as its own independent package/service — not merged into the existing Next.js app, and not (yet) split into a separate git repository.**

Reasoning:
- **Different runtime**: the existing app (`src/`) is a Next.js/TypeScript frontend for the "SitesNSign AI Executive" command center. A real-time, low-latency, streaming voice pipeline with VAD/barge-in is best built in **Python** (Pipecat is Python-native, and the STT/TTS/LLM streaming ecosystem is most mature there) or, alternatively, Node.js with a dedicated WebSocket/media-streaming runtime. Either way, it is architecturally a distinct service with its own dependency tree, deployment target, and scaling profile (persistent WebSocket connections and audio processing vs. a request/response web frontend) — it should not live inside `src/` or share `package.json`/`next.config.ts` with the Next.js app.
- **Why same repo (monorepo) rather than a fully separate repo, for now**: at this stage (pre-Phase-1, no code yet) keeping it in the same repo as a sibling top-level directory keeps founder context, CI/CD account, and issue tracking unified while the two products are still closely related (the voice agent will call into or share data with the same CRM/lead/agent-registry concepts the Next.js app already models, and — for the founder's own real-estate tenant specifically — several existing skills in this account, e.g. Site Visit Coordinator, Home Loan/EMI Agent, Buyer/Seller Relationship Agent, are natural tool-call targets; other tenants in other verticals wire their own tools instead). A monorepo with clearly separated top-level packages (`src/` for the Next.js app, `voice-agent-platform/` for the new Python/Node service) avoids repo-sprawl overhead for a small team while Phase 1 is still being scoped. This is also the intended future home of a standalone `ai-calling-agent` GitHub repo once the founder creates one — see the README's Migration note.
- **When to split into a separate repo**: recommend revisiting this once the voice platform has its own CI/CD pipeline, its own on-call/deployment cadence (likely much more frequent given real-time infra tuning), and a distinct enough contributor set that a shared repo starts to create merge/ownership friction — a common trigger is when the voice service needs its own container registry, its own secrets/compliance boundary (call recordings, PII), or when a dedicated backend team forms around it. None of those conditions are met yet at Phase 0.
- **No coupling in the meantime**: this decision assumes `voice-agent-platform/` remains fully additive — no shared code, shared `node_modules`, or shared build step with `src/` — so either service could still be split out later with a simple `git filter-repo`/subtree extraction if needed, without having entangled the two.

## Multi-tenancy / white-label / reseller / multi-industry considerations (for Phase 1 design, noted here for continuity)

- Every adapter (telephony/STT/TTS/LLM) selection, prompt/persona, branding, pipeline-stage set, and disposition set must be tenant-configurable, since resale/white-label **and** multi-industry support are both first-class goals per the founder's revised spec — a tenant is never assumed to be in real estate.
- The `agent_prompts` / Agent Builder config table is the single place vertical-specific behavior lives; it is populated either directly by a tenant/admin or generated by the Prompt-to-Agent Builder (see `PROMPT_TO_AGENT_BUILDER.md`), and the core pipeline/orchestrator code must never branch on an industry name.
- Call recordings, transcripts, and consent records must be tenant-isolated in Postgres (row-level security or schema-per-tenant, to be decided in Phase 1) given the TRAI/DLT/DND compliance obligations detailed in `COMPLIANCE.md`.
