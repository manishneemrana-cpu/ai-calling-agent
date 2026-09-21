# Phase 0 Summary

## 10-line summary of understanding

1. SitesNSign (Manish, Patna, Bihar) wants a separate, new product: a production-grade, multi-tenant, white-label AI Voice Sales Agent platform for Indian real estate builders/brokers.
2. Resale/reseller support is a first-class design goal, not an afterthought — every layer must be swappable/configurable per tenant.
3. The platform places and receives real-time phone calls, using an AI pipeline (STT → LLM → TTS) with low-latency streaming and barge-in (interruptible speech).
4. Every external vendor (telephony, STT, TTS, LLM) must sit behind a provider-agnostic adapter interface — never hard-coded — so tenants/resellers can be configured to different vendors without code changes.
5. India-specific telephony (Plivo/Exotel) and India-specific STT/TTS (Sarvam) are prioritized for Hindi/Hinglish/code-switching quality and cost, with global providers (Deepgram, Cartesia, ElevenLabs, Groq) as alternates/premium options.
6. Cost is a first-order design constraint: the founder has a ₹1/min *target* for an Economy tier, explicitly framed as a target, not a guarantee, requiring documented assumptions.
7. TRAI/DLT/DND/TCCCPR compliance is mandatory and non-trivial for AI-originated outbound calls in India, and is explicitly called out as needing professional legal review before go-live.
8. Real-time call audio must architecturally never pass through n8n — n8n is the control-plane for surrounding business workflows (CRM sync, WhatsApp, scheduling) only.
9. This is a new, separate service from the existing Next.js "SitesNSign AI Executive" app already in this repo, likely in Python or Node given its real-time streaming needs, and Phase 0 recommends it live as a new top-level sibling directory in this same repo for now, not a separate git repository.
10. Phase 0's scope is strictly discovery/verification/documentation — no application code — with a stack decision that requires the founder's explicit approval before Phase 1 begins.

## Up to 5 blocking questions for the founder before Phase 1

1. **Stack approval**: Do you approve the recommended primary stack — Plivo (telephony), Sarvam (STT+TTS), Gemini Flash-Lite (LLM), Pipecat (orchestration framework), PostgreSQL+pgvector, Redis — as documented in `STACK_PROPOSAL.md`, or do you want a different combination evaluated further before Phase 1 starts?
2. **Budget & API-key/account availability**: Do you already have (or can you get within days) developer accounts and API keys for Plivo, Sarvam, and Google Gemini, and an approved monthly budget ceiling for Phase 1 pilot testing (the cost model in `COST_MODEL_V1.md` is per-minute, not a total budget)?
3. **Existing telephony accounts**: Do you already have a Plivo and/or Exotel account (with DLT registration in progress or completed), or does Phase 1 need to start that registration process from zero — this materially affects timeline, since DLT registration is not instant?
4. **Target launch date & initial use case**: What is the target date for a working pilot, and is the first use case inbound calls (customers calling in) or outbound calls (the platform calling leads) — this changes the compliance burden significantly (see `COMPLIANCE.md`) and should shape what Phase 1 builds first.
5. **Repo/monorepo decision**: Do you agree with keeping `voice-agent-platform/` as a sibling top-level directory in this same repo for now (per the reasoning in `ARCHITECTURE.md`), or would you prefer it start as a fully separate repository from day one?
