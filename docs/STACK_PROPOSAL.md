# Stack Proposal — Phase 0

This proposes a primary + alternate adapter per component, following the spec's rule: **never hard-code a provider — every external dependency sits behind a provider-agnostic adapter interface** so a tenant/reseller can be reconfigured to a different vendor without a code change to the core pipeline.

This stack is **vertical-agnostic**: the same Telephony/STT/TTS/LLM/orchestration layers serve any tenant in any industry. What differs per tenant is not the stack but the Agent Builder config layered on top of it (persona, prompt, tools, pipeline stages) — see `PROMPT_TO_AGENT_BUILDER.md`. Real estate is one persona template, not a stack assumption.

The user-sketched table is verified/updated below against current findings (see `VERIFICATION.md`). The founder confirmed this Plivo/Sarvam/Gemini/Pipecat stack as the **approved default** on 2026-09-21, while asking that cheaper alternatives keep being surfaced as swappable options, never hardcoded — see `VERIFICATION.md` §8 for the newly researched STT/TTS/LLM alternates.

**2026-09-21 update (founder follow-up #2 — telephony specifically)**: the founder pushed back on a Plivo-or-Exotel-only telephony choice and asked for a wide sweep of affordable India voice options, evaluated with the same rigor as STT/TTS/LLM: ranked by verified cost, with real-time bidirectional audio streaming (not just IVR/recording/webhooks) as a hard gate. Full research in `VERIFICATION.md` §7. **The telephony row below is now a ranked list of every provider confirmed to support real-time streaming, cheapest-first** — the single Primary/Alternate cell is retired in favor of this.

### Telephony — ranked, streaming-capable providers only (cheapest first)

| Rank | Provider | Verified India voice rate | Streaming confirmed? | Notes |
|---|---|---|---|---|
| 1 | **FreJun Teler** | **₹0.15/min outbound + ₹0.10/min inbound + ₹0.15/min streaming add-on** ≈ **₹0.28–₹0.30/min blended** | **Yes** — raw WebSocket, AI-stack-agnostic, Pipecat-compatible | Cheapest verified option by a wide margin (~3x cheaper than Plivo). Markets native DLT/DND handling. Newer/smaller brand than the incumbents — min. 10 channels + 12-month DID commitment + Aadhaar KYC to go to production; **recommend a paid pilot to confirm uptime/SLA before committing production traffic**, not adopted blind on marketing numbers alone. |
| 2 | **Plivo** (India) | **₹0.60/min voice + $0.004/min (~₹0.35/min) streaming add-on** ≈ **₹0.95/min** | Yes — confirmed, `<Stream>` bidirectional, first-party Pipecat serializer | Most mainstream/best-documented option; matches the Phase 0 benchmark closely. Rate is a search-snippet figure (direct plivo.com fetch blocked in this environment) — confirm via console/sales before Phase 2 build. |
| 3 | **Exotel** | Not publicly priced — sales quote only; third-party estimate ₹0.60–₹1.80/min | Yes — confirmed, AgentStream bidirectional, Pipecat transport exists | Same streaming tier as Plivo; only public-pricing gap keeps it below Plivo in this ranking. |
| 3 | **Tata Tele Smartflo** | Not publicly priced for the Voice Streaming API tier specifically — sales quote only; generic Cloudphone plans suggest ₹0.30–₹0.80/min | Yes — confirmed directly from Tata's own developer docs (bidirectional 8kHz μ-law WebSocket, static/dynamic endpoint config) | Backed by a licensed telecom operator (not just a CPaaS reseller) — potentially stronger DLT/BFSI compliance story; needs a sales quote to rank against Plivo on cost. |
| 3 | **Acefone / Servetel** | Not publicly priced — sales quote only | Yes — confirmed, Acefone's own "Voice Streaming API" + published SOP doc, same interruption/barge-in capability as the others | Servetel appears to be a reseller/brand of the Acefone platform. Genuinely streaming-capable; cost position unknown pending a quote. |
| 6 | **Ozonetel** | Not publicly priced — sales quote only | **Plausible, not confirmed** — third-party/partner signals (ElevenLabs' own Ozonetel integration) suggest a working streaming path, but no first-party technical doc was found spelling out the WebSocket contract the way Plivo/Exotel/Tata/Acefone do | Treat as "needs a hands-on technical spike before adoption," not yet on par with the confirmed group above. |
| 7 | **Twilio** (global, India rates) | ₹0.35/min inbound, ₹0.65/min outbound (or ~₹0.40/₹0.66 via USD rates) | Yes — confirmed, the original Media Streams pattern the others copied | Kept as the **global-fallback/comparison alternate**, not an India-primary: no India-specific DLT/DND/TRAI tooling, USD-denominated billing (FX risk). |

**Excluded — no confirmed real-time bidirectional audio streaming (cost was not even evaluated as the disqualifying factor)**:
- **Knowlarity (SuperReceptionist)** — public docs describe IVR, click-to-call, and a "voicebot"/"AI bots" line, but no evidence of a first-party live audio WebSocket API was found. Likely scripted-IVR-style rather than live bidirectional audio; needs direct sales/technical confirmation before reconsidering.
- **Airtel IQ** — public APIs found cover call-flow/IVR and one-to-one WebRTC video, not a PSTN voice-bot audio-streaming API. Some partner voicebot solutions are listed in its marketplace, but that appears to route through the partner's own infra, not a first-party Airtel IQ streaming API.
- **MyOperator** — reads as a traditional cloud-PBX/call-center IVR product (call routing, recording, logs); no streaming evidence found.
- **Direct SIP trunk (Airtel Business / Jio / Tata Communications / BSNL)** — technically these carriers' infrastructure underlies several of the CPaaS options above, and real-time audio over SIP is of course possible in principle, but there is no self-serve API/signup path — only enterprise sales, dedicated circuits, and volume commitments. **Not viable for a startup at Phase 1/2 scale**; revisit only once volume (likely 100K+ min/month) justifies the enterprise sales cycle.
- **Kaleyra, Route Mobile, Karix** — no findable public per-minute India voice pricing; Kaleyra is additionally flagged by a third-party source as having "limited" real-time WebSocket streaming support. Skipped per the research brief's own instruction to omit providers with no findable pricing.

### Recommended default: **FreJun Teler**, not Plivo — cost win is too large to ignore, but flagged as needing a paid pilot first

FreJun Teler's verified blended rate (≈₹0.28–0.30/min including the streaming add-on) is roughly a **third of Plivo's** (≈₹0.95/min) for the same real-time-streaming capability. Per the founder's own instruction not to favor Plivo for continuity's sake, **FreJun Teler is now the recommended starting default**, with **Plivo kept as the primary fallback/alternate** given its far longer production track record, better documentation, and first-party Pipecat integration. Concretely: **Phase 2 should build the FreJun Teler adapter first, build the Plivo adapter second, and pilot both on real traffic before deciding which one is the default for new tenants** — this is exactly the swappable-adapter pattern the founder asked for, so the decision is a config choice, not a rewrite, either way. Exotel, Tata Smartflo, and Acefone/Servetel are documented as further alternates once their pricing is confirmed via sales quotes; Ozonetel needs a technical spike before it can be ranked at all.
| STT | **Sarvam STT** (Saaras, successor to Saarika) | Deepgram (Nova-3), Groq-hosted Whisper large-v3-turbo, Vosk (self-hosted, offline) | Confirm the Saarika→Saaras v3 migration at integration time — Saarika v2.5 is being deprecated. Groq Whisper is the cheapest raw $/min found but is better suited to fast batch/near-real-time transcription than a live low-latency socket; keep as a cost-optimization fallback, not a live-turn default. **Watch (unconfirmed streaming, not yet a listed alternate)**: Bhashini (Govt of India, free/near-free for Indian languages, streaming support unconfirmed — VERIFICATION.md §8.5). |
| TTS | **Sarvam Bulbul** (v3) | Cartesia (Sonic-3/Turbo), ElevenLabs, Piper (self-hosted) | Bulbul remains cheapest + best Indian-language coverage with confirmed streaming. Cartesia added as the **low-latency Premium alternate** (40–90ms time-to-first-audio) for English-heavy or latency-critical flows. ElevenLabs is the quality ceiling at the highest cost — reserve for flagship/high-value calls only. Piper is a viable Economy self-hosted fallback but its **engine relicensed to GPL-3.0 in Oct 2025** (was MIT) — flag for legal review before shipping (see COMPLIANCE.md/VERIFICATION.md). Coqui/XTTS evaluated and **rejected** — its usable pretrained weights are CPML-licensed (non-commercial only), a harder blocker than Piper's GPL-3.0. **Watch**: Smallest.ai (~$13.50/M chars, confirmed streaming, India-based — cheaper than Cartesia but not yet proven cheaper/better than Bulbul; VERIFICATION.md §8.2). Neuphonic and Rime evaluated — both confirmed streaming but priced at or above Cartesia/ElevenLabs for this volume; not adopted (VERIFICATION.md §8.3–8.4). "Voicebox" investigated per founder request — **not a viable option in any form** (Meta's research model was never released; other same-named products are unrelated local tools or an unrelated voicemail product — VERIFICATION.md §8.1). |
| LLM | **Gemini Flash-Lite/Flash** | Groq Llama 3.1-8B-Instant | Both current Gemini 2.5 Flash-Lite and 2.5 Flash are **scheduled for deprecation on 2026-10-16** — re-verify the successor model/price before Phase 1 build. Groq's Llama 3.3-70B moved to enterprise-only pricing on 2026-08-26 and is no longer a self-serve alternate for cost modeling; Llama 3.1-8B-Instant remains self-serve and is documented here as the practical alternate. |
| Orchestration framework | **Pipecat** | LiveKit Agents | Pipecat's transport-agnostic pipeline plus existing first-party Plivo and Exotel integrations map directly onto the adapter-interface requirement. LiveKit Agents is the alternate for if/when the platform needs LiveKit's own WebRTC/SIP infra at larger concurrent-call scale. |
| Database | **PostgreSQL + pgvector** | — (spec-mandated, not a swappable adapter) | Stores tenant/call/transcript/CRM data plus vector embeddings for RAG-style knowledge lookups (property listings, FAQs) the agent can call as a tool. |
| Cache / Queue | **Redis** | — (spec-mandated) | Session state for in-flight calls, rate limiting, pub/sub between the voice gateway and orchestrator, and a queue for outbound-call jobs. |

## WhatsApp (Phase 6, added 2026-09-22)

| Layer | Primary | Alternate | Reasoning |
|---|---|---|---|
| WhatsApp | **Interakt** (BSP) | **Gupshup** (BSP) | See `VERIFICATION.md` §10 for full research. Interakt is an official Meta Business Solution Provider with the most transparent published per-conversation pricing of the compared BSPs (~₹0.95-0.97/marketing conversation) and a fast small-business onboarding path — the right fit for a small Indian startup's first WhatsApp integration. Gupshup is the enterprise-grade fallback (proven at BFSI scale) once volume outgrows a small BSP, kept `beta` in the `providers` catalog pending a real sales quote. Direct Meta Cloud API was evaluated and **not** chosen as the Phase 6 default — it shifts webhook/template/rate-limit engineering onto the team, which a BSP's markup buys away at this stage; it remains the documented long-term option once that bandwidth exists. |

Same adapter-interface principle as Telephony/STT/TTS/LLM: business logic
depends only on `WhatsAppProvider` (`apps/web/lib/providers/whatsapp/types.ts`),
resolved via the same DB-driven Provider Registry
(`tenant_provider_config` with `layer='whatsapp'`) — switching a tenant
from Interakt to Gupshup, or to a real Meta Cloud API adapter later, is a
config row change, never a code change. Per the Phase 6 multi-industry
pivot, the interface's methods are generalized verbs (`sendDocument`,
`sendMedia`, `sendLocation`, `sendAppointmentConfirmation`, `sendReminder`,
`sendFollowUp`) rather than the master spec's real-estate-flavored names
(`sendProjectDetails`, `sendPropertyImages`, `sendBrochure`,
`sendSiteVisitConfirmation`) — a real-estate template is one tenant
`templateKey` configuration among others, never a method name.

## Adapter interface principle

Each of Telephony, STT, TTS, and LLM must be implemented as a small internal interface, e.g.:

- `TelephonyAdapter`: `place_call()`, `answer_call()`, `open_media_stream()`, `hangup()`, `send_dtmf()` — implemented once per provider (Plivo, Exotel, …).
- `STTAdapter`: `stream_audio_chunk() -> partial/final transcript events`.
- `TTSAdapter`: `synthesize_stream(text) -> audio chunks`.
- `LLMAdapter`: `generate(messages, tools) -> streamed tokens / tool calls`.

Per-tenant (and per-reseller white-label) configuration selects which concrete adapter to instantiate for each layer, so a reseller could, for example, run Economy tier on Sarvam+Gemini+Plivo while a Premium tenant runs Cartesia+Gemini Flash+Plivo, with zero core-pipeline code changes — only config.

## Why Pipecat over LiveKit Agents (summary; full detail in VERIFICATION.md)

- Confirmed first-party Pipecat serializers/transports for **both** Plivo and Exotel already exist, which is a direct, low-risk path to the two India telephony providers this spec requires.
- Pipecat's frame-processor pipeline model gives fine-grained control over barge-in behavior and per-stage provider swapping — matching the adapter-interface requirement more naturally than LiveKit Agents, which is architected around LiveKit's own WebRTC server.
- Python-first, open-source (no vendor lock to a hosted media server), consistent with running this as a separate Python service (see ARCHITECTURE.md).
- LiveKit Agents remains the documented alternate for a future point where the platform needs LiveKit's own SIP-trunking/WebRTC infrastructure at a much larger concurrent-call scale than Phase 1 targets.

## Payment gateway (Phase 7, added 2026-09-22)

| Layer | Primary | Alternate | Reasoning |
|---|---|---|---|
| Payment gateway | **Razorpay** | **Cashfree** | See `VERIFICATION.md` §11 for full research. Razorpay's developer-friendly Payment Links/Subscriptions APIs and webhook-signature-verification flow are the better fit for this platform's wallet-top-up + future subscription billing than Cashfree's stronger-but-differently-focused instant-payouts product. Cashfree is cataloged (`beta`) as the cost-optimization fallback (~1.75-1.95% vs ~2% published TDR) once real volume justifies a quote comparison. |

Same adapter-interface principle as every other layer: business logic
depends only on `PaymentGatewayProvider`
(`apps/web/lib/providers/payment_gateway/types.ts`), resolved via the same
DB-driven Provider Registry (`tenant_provider_config` with
`layer='payment_gateway'`). The Mock adapter is fully implemented for
tests/demo mode; the Razorpay adapter is a real REST API implementation
structured for dependency-injected `fetch`, unit-tested against a mocked
HTTP client and a hand-computed HMAC signature (no live keys needed —
`apps/web/tests/billing/razorpay-adapter.test.ts`). Cashfree is cataloged
in the `providers` table but has no adapter class yet — a documented
follow-up, not a Phase 7 blocker.

Wallet-credit idempotency: a webhook redelivery must not double-credit a
tenant's wallet. This is enforced the same way Phase 2 enforced telephony-
webhook idempotency — a SECURITY DEFINER SQL function
(`credit_wallet_from_payment`, `db/migrations/012_phase7_billing.sql`)
that atomically records the delivery in `payment_webhook_events`
(`UNIQUE(gateway_provider_key, idempotency_key)`) and credits the wallet
in the same transaction only on the first delivery. Proven by
`apps/web/tests/billing/payment-webhook-idempotency.test.ts`.

### Phase 8 extension point (documented, not implemented)

`billing_accounts.reseller_id` (nullable, currently unused by any Phase 7
code path) is where Phase 8's reseller/white-label hierarchy will route a
tenant's billing through a reseller markup, without a schema rewrite —
see `db/migrations/012_phase7_billing.sql`'s column comment.
