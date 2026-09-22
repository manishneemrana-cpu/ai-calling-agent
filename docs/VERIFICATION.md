# Verification Log — Phase 0

All findings below were gathered via live web search on **2026-09-21**. Pricing for AI APIs changes frequently (several vendors below changed pricing or deprecated models within the last few months) — treat every number here as a snapshot to be re-verified before Phase 1 signs a contract, not as a locked-in cost. Where a vendor does not publish pricing (e.g. Exotel), figures are third-party estimates and are marked as such.

---

## 1. Telephony (India)

### 1.1 Plivo
- Pay-as-you-go voice pricing exists globally from ~$0.010/min; a dedicated India pricing page exists at plivo.com/voice/pricing/in/ but exact per-minute India rates were not extractable via search snippet or fetch (direct fetch to plivo.com was blocked by this environment's egress proxy — must be re-verified by logging into the Plivo console or contacting sales before committing to a cost model).
- **Bidirectional audio streaming (WebSocket)**: confirmed supported. Enabled via `<Stream>` XML with `bidirectional="true"`, `audioTrack="inbound"` (or `both`), audio as `audio/x-mulaw` @ 8kHz mono, base64-encoded chunks. Add-on cost: **$0.004/min** on top of base voice minutes. SDKs exist for Python/Java (event-driven WebSocket callbacks), and Pipecat has a first-party `PlivoFrameSerializer`.
- **DLT/DND**: Plivo is an India-licensed OSP/ILD provider and integrates with DLT-registered sender IDs for SMS; for voice, compliance responsibility (DLT registration of the calling entity, DND scrubbing of numbers before dialing) sits primarily with the customer, not automated by Plivo out of the box — needs explicit confirmation from Plivo sales for the voice+DLT integration story.
- Sources: [Plivo Voice Pricing (IN)](https://www.plivo.com/voice/pricing/in/), [Plivo Audio Streaming for Voice AI](https://www.plivo.com/audio-streaming/), [Plivo Audio Streaming docs](https://www.plivo.com/docs/voice/xml/audio-streaming), [How Plivo Bidirectional Audio Streaming Works](https://medium.com/@vinayak702010/how-plivo-bidirectional-audio-streaming-works-over-websockets-c4f07fbdc8a4), [Plivo vs Exotel vs Ozonetel vs Twilio India 2026](https://caller.digital/blog/telephony-partner-voice-ai-india-plivo-exotel-ozonetel-knowlarity-twilio-2026)

### 1.2 Exotel
- Exotel does **not publish pricing publicly**; its pricing page routes to a sales conversation. Third-party aggregator estimates (Sep 2026): Grow plan outbound ≈ **₹0.60–₹1.50/min**; industry benchmark range for India voice generally: outbound-to-mobile ₹0.80–₹1.80/min via aggregator or ₹0.60–₹1.20/min via direct SIP; inbound toll-free ₹1.20–₹2.50/min. Credits model: ~$0.01/credit, spent across voice/SMS/WhatsApp, billed on 30s or 60s pulse depending on plan.
- **Streaming (bidirectional)**: confirmed supported via **AgentStream** / the "Stream and Voicebot Applet" — bidirectional WebSocket streaming of raw/slin 16-bit 8kHz mono PCM (base64), chunked in multiples of 320 bytes. Documented events: Connected, Start, Media, DTMF, Stop, Clear. Exotel publishes a worked example wiring AgentStream to OpenAI's Realtime API, and Pipecat ships a dedicated Exotel WebSocket transport.
- **DLT/DND**: Exotel is a long-standing India telecom/CPaaS player and markets itself on TRAI/DLT compliance tooling for its call-center and IVR customers, but exact automated-DND-scrubbing and DLT-registration-assist features for a third-party AI calling platform need direct confirmation from Exotel's compliance/sales team — not fully documented in public sources found.
- Sources: [Exotel Pricing 2026 guide](https://www.cloudtalk.io/blog/exotel-pricing/), [Exotel AgentStream developer guide](https://developer.exotel.com/docs/agentstream/developer-guide), [Exotel Stream/Voicebot Applet](https://developer.exotel.com/docs/agentstream/stream-voicebot-applet), [Exotel AgentStream bidirectional blog](https://exotel.com/blog/build-a-real-time-speech-to-speech-ai-voice-assistant-on-exotel-agentstream-bidirectional-with-openai-realtime-python/), [Pipecat Exotel WebSocket transport](https://docs.pipecat.ai/deployment/pipecat-cloud/guides/telephony/exotel-websocket)

**Recommendation impact**: Both providers support the bidirectional-streaming pattern this platform needs; Plivo's per-minute add-on for streaming ($0.004/min) is explicitly published, Exotel's is not — a point in Plivo's favor for cost auditability, pending final India per-minute rate confirmation for both.

---

## 2. Speech-to-Text (STT)

### 2.1 Sarvam AI (Saarika / Saaras)
- **Pricing**: ₹30/hour of audio (₹0.50/min); ₹45/hour (₹0.75/min) with speaker diarization. Pay-per-use, billed in INR. New accounts get ₹1,000 free credits. Tiers: Starter (PAYG, 60 req/min), Pro (₹10,000/mo, 200 req/min), Business (₹50,000/mo, 1,000 req/min).
- **Model note**: Saarika v2.5 is being deprecated; Sarvam is steering customers to **Saaras v3** — confirm active model name before integration.
- **Language/streaming**: Purpose-built for Indian languages, multi-speaker and mixed-language (Hindi/Hinglish code-switching) content; streaming STT is supported per Sarvam + Pipecat's official Sarvam integration.
- Sources: [Sarvam API Pricing](https://www.sarvam.ai/api-pricing), [Sarvam Pricing docs](https://docs.sarvam.ai/api-reference-docs/pricing), [Sarvam STT REST API](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/rest-api)

### 2.2 Deepgram (Nova-3)
- **Pricing**: Streaming Pay-As-You-Go: **$0.0077/min** standard (a promo rate of $0.0048/min was noted as time-limited). Growth/annual-prepaid tier: **$0.0065/min**. Speaker diarization add-on: +$0.0020/min on streaming. Billed by actual audio duration, not rounded minutes.
- **Language**: Strong English/multilingual; Hindi/Indian-language + code-switching quality is not as proven as Sarvam for Hinglish — treat as a fallback/alternate for English-heavy segments, not primary for vernacular.
- Sources: [Deepgram Pricing](https://deepgram.com/pricing), [Deepgram Pricing 2026 breakdown](https://www.happyrobot.ai/hub/deepgram-pricing), [Deepgram Nova-3 pricing analysis](https://brasstranscripts.com/blog/deepgram-pricing-per-minute-2025-real-time-vs-batch)

### 2.3 Groq-hosted Whisper (large-v3 / large-v3-turbo)
- **Pricing**: Whisper **large-v3-turbo**: **$0.04/hour** of audio (~$0.00067/min) — Groq's LPU inference makes this dramatically cheaper than OpenAI's own Whisper API ($0.36/hr). Whisper large-v3 (non-turbo, higher accuracy): $0.111/hour (~$0.00185/min).
- **Note**: Groq Whisper is typically used as **batch/near-real-time** transcription (fast turnaround, not a native low-latency streaming socket like Deepgram/Sarvam); for a live barge-in voice agent it is more often paired with short-chunk streaming or used as a cost-optimized fallback rather than the primary live-turn STT. Self-hosted faster-whisper (open-source, MIT license) remains an option for on-prem/data-residency-sensitive deployments at infra cost only (GPU/CPU hosting), trading pricing for ops burden.
- Sources: [Groq Whisper large-v3-turbo pricing](https://console.groq.com/docs/model/whisper-large-v3-turbo), [Groq pricing overview 2026](https://www.eesel.ai/blog/groq-pricing)

**STT recommendation impact**: Sarvam remains the strongest primary for Hindi/Hinglish/code-switching quality and is India-priced in INR (auditable for an India-first product); Deepgram and Groq Whisper are credible alternates/fallbacks, with Groq Whisper being the cheapest option for high-volume English-heavy or batch-style transcription.

---

## 3. Text-to-Speech (TTS)

### 3.1 Sarvam Bulbul (v3, beta pricing as of Aug 2026)
- **Pricing**: ₹30 per 10,000 characters (~$3.60/million characters — far below Western TTS APIs charging tens of dollars per million characters). ₹100 free credits on signup.
- **Languages/voices**: 30+ persona voices across 11 Indian languages (Hindi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Marathi, Punjabi, Odia, English-IN), adjustable speed 0.5x–2.0x, streaming supported (confirmed via official Pipecat Sarvam TTS service integration).
- Sources: [Sarvam Bulbul v3 explainer](https://invideo.io/blog/sarvam-bulbul-indian-tts/), [Sarvam API Pricing](https://www.sarvam.ai/api-pricing), [Pipecat Sarvam TTS service](https://docs.pipecat.ai/api-reference/server/services/tts/sarvam)

### 3.2 Cartesia (Sonic-3 / Sonic Turbo)
- **Pricing**: credit-based, ~1 credit/character, plans from free (20K credits) to Scale ($299/mo, 8M credits) → roughly **$5–$37 per million characters** depending on plan tier. Voice-cloning at 1.5 credits/char. A dedicated "Line" voice-agent product bills flat **$0.06/min** of call duration.
- **Streaming**: WebSocket-native, industry-leading latency — Sonic-3 ~90ms time-to-first-audio, Sonic Turbo ~40ms.
- **Indian language support**: not confirmed as a strength; primarily English/global-language focused — treat as a Premium-tier low-latency alternate, not a Hindi-first primary.
- Sources: [Cartesia Pricing docs](https://docs.cartesia.ai/pricing), [Cartesia Sonic 3 pricing 2026](https://www.eesel.ai/blog/cartesia-sonic-3-pricing)

### 3.3 ElevenLabs
- **Pricing**: API $0.10/1,000 characters (multilingual models) or $0.05/1,000 characters (Flash/Turbo models) → **$50–$100/million characters**, the most expensive option evaluated. Commercial license included from the Starter ($5/mo) plan up; free tier disallows commercial use.
- **Quality**: widely regarded as top-tier for naturalness/emotion, supports Hindi among its multilingual models, but at premium cost — a Premium-tier candidate only for flagship/high-value calls.
- Sources: [ElevenLabs Pricing 2026 breakdown](https://www.cekura.ai/blogs/elevenlabs-pricing), [ElevenLabs official pricing](https://elevenlabs.io/pricing)

### 3.4 Piper (open-source, self-hosted)
- **Licensing (important, changed recently)**: the original `rhasspy/piper` repo was **MIT-licensed** but was **archived (read-only) in October 2025**. Active development moved to `OHF-Voice/piper1-gpl`, which is **GPL-3.0**. GPL-3.0 is copyleft — distributing/linking the engine into a proprietary product can trigger source-release obligations; running it as an arm's-length internal HTTP service (Pipecat's documented pattern) avoids linking it directly into proprietary code, but this is a legal question, not just a technical one, and should be reviewed by counsel before shipping. Individual voice models also carry their own licenses (some are "personal use/research only") — each voice must be checked separately.
- **Cost**: no per-request API cost — only self-hosting infra (CPU is often sufficient; GPU not required), making it the cheapest TTS option at volume but with real ops and licensing overhead.
- Sources: [Piper TTS licensing explainer](https://www.cekura.ai/discover/piper-tts), [Coqui/Piper licensing comparison 2026](https://www.promptquorum.com/power-local-llm/local-tts-voice-cloning-piper-coqui-xtts)

### 3.5 AI4Bharat Indic Parler-TTS / IndicF5
- Open-source Indic TTS research models from AI4Bharat; no commercial hosted pricing (self-host only). Quality and production-readiness for a commercial low-latency voice pipeline is less proven than Sarvam Bulbul or Piper in production deployments as of this search; recommend treating as an experimental/future self-hosted option pending a dedicated technical eval, not a Phase 1 default.

**TTS recommendation impact**: Sarvam Bulbul remains the strongest primary on cost + Indian-language coverage + confirmed streaming; Cartesia is the best low-latency Premium alternate; ElevenLabs is a quality-ceiling option at high per-minute cost; Piper is viable as a self-hosted Economy fallback but its GPL-3.0 relicensing must be reviewed by counsel before use in a commercial SaaS.

---

## 4. LLM

### 4.1 Google Gemini Flash-Lite / Flash
- **Gemini 2.5 Flash-Lite**: $0.10/M input tokens, $0.40/M output tokens. **Being retired 2026-10-16.**
- **Gemini 2.5 Flash**: $0.30/M input, $2.50/M output. Also scheduled for deprecation 2026-10-16.
- **Successors** (as found at search time): Gemini 3.1 Flash-Lite ($0.25 in / $1.50 out), Gemini 3.5 Flash-Lite ($0.30 in / $2.50 out) — i.e., the "Flash-Lite" successor tier has gotten **more expensive** than the 2.5 generation it replaces. **This must be re-verified at Phase 1 kickoff** since both current models expire within weeks of this document and pricing/model naming is actively shifting.
- Sources: [Gemini API official pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini pricing 2026 overview](https://www.cloudzero.com/blog/gemini-pricing/), [Gemini 2.5 Flash-Lite pricing detail](https://pricepertoken.com/pricing-page/model/google-gemini-2.5-flash-lite)

### 4.2 Groq-hosted Llama
- **Llama 3.3 70B**: as of **2026-08-26**, Groq moved this model to **enterprise-only "contact sales" pricing** — no longer self-serve. Last public self-serve rate was $0.59/M input, $0.79/M output.
- **Llama 3.1 8B Instant** (still self-serve): $0.05/M input, $0.08/M output — the cheapest viable Groq option, at some quality cost vs. 70B.
- **Implication**: the original spec's "Groq Llama 3.1/3.3 hosted" alternate is now split — 3.1-8B remains a cheap self-serve alternate, but 3.3-70B requires an enterprise sales conversation, which changes cost predictability for that path.
- Sources: [Groq pricing 2026 overview](https://www.cloudzero.com/blog/groq-pricing/), [Groq Llama 3.1 8B pricing](https://www.helicone.ai/llm-cost/provider/groq/model/llama-3.1-8b-instant), [Llama 3.3 70B cost analysis 2026](https://markaicode.com/pricing/llama-33-pricing/)

**LLM recommendation impact**: Gemini Flash-Lite remains the primary on cost given its per-token rate is still lowest found, but its Sep–Oct 2026 deprecation means Phase 1 must pin down the exact successor model and price at build time, not rely on this document's numbers. Groq Llama 3.1-8B-Instant is a credible ultra-cheap alternate for the Economy tier; Groq 3.3-70B is no longer a self-serve alternate for cost modeling purposes.

---

## 5. Orchestration Framework: Pipecat vs LiveKit Agents

- **Pipecat** (Daily, open-source, Python): transport-agnostic pipeline of swappable frame processors (STT/LLM/TTS as pipeline stages); plugs into Daily, LiveKit, raw WebSocket, or a Twilio/Plivo/Exotel phone leg. Strongest for conversation-logic control (barge-in tuning, frame-level audio, provider swapping) and has first-party serializers/integrations for Plivo and Exotel already (confirmed above), a large and fast-moving integration library.
- **LiveKit Agents**: built on LiveKit's own WebRTC media server — wins on production media/infra (reconnection handling, low-latency transport, native SIP trunking, scaling to many concurrent calls) if self-hosting LiveKit's server.
- **2026 consensus from multiple comparison sources**: Pipecat is regarded as the strongest general-purpose open-source voice-agent framework for teams that need broad provider flexibility and fast iteration; LiveKit Agents is preferred when the primary challenge is WebRTC/SIP infrastructure at large scale.
- **Recommendation**: **Pipecat** as primary — its transport-agnostic design and existing Plivo/Exotel integrations map directly onto this project's telephony-adapter requirement (never hard-code a provider), and its Python-first design matches the real-time-streaming runtime this service needs (see ARCHITECTURE.md). LiveKit Agents documented as the alternate if/when concurrent-call scale or native SIP trunking needs outgrow Pipecat's current telephony glue.
- Sources: [Pipecat vs LiveKit — Forasoft](https://www.forasoft.com/blog/article/pipecat-vs-livekit-agents), [Vapi vs Pipecat vs LiveKit 2026](https://inworld.ai/resources/vapi-vs-pipecat-vs-livekit), [Pipecat vs LiveKit — Cekura](https://www.cekura.ai/blogs/pipecat-vs-livekit-the-real-difference)

---

## 6. Compliance: TRAI / DLT / DND / TCCCPR

- **TCCCPR 2018** is the base regulation (Telecom Commercial Communications Customer Preference Regulations), amended most recently in **February 2025** and again in **September 2026**.
- **February 2025 amendment** key changes: spam-reporting window extended from 3 to 7 days; "inferred consent" now valid only for the life of the contractual relationship; "explicit consent" for a commercial transaction now valid for only **7 days** from the date it was acquired (must be re-obtained per interaction cycle beyond that window); a key compliance deadline of **10 March 2026** was set for final provisions to take full effect.
- **Numbering series requirement**: promotional commercial calls must originate from **140-series** numbers; BFSI service calls must use **1600-series** numbers (deadline **1 January 2026**).
- **DLT mandate**: every commercial caller must be registered on the DLT (Distributed Ledger Technology) platform (via a registered telemarketer entity and registered headers/templates) **before making any outbound commercial call or message** — this applies to automated/AI voice calls exactly as it does to human agents; TRAI has explicitly stated automated voice systems are subject to the same TCCCPR rules as human-operated call centres.
- **DND**: numbers registered on the National Do Not Disturb (NDNC) registry must be scrubbed from any outbound commercial calling list unless the customer has valid, current explicit or inferred consent as defined above.
- **September 2026 amendment**: introduces AI/ML-based detection by telecom service providers (TSPs) to identify Customer Line Identifications (CLIs) with high probability of being used for unsolicited commercial communication — i.e. regulatory enforcement itself is now becoming AI-driven, raising the bar for compliant registration/sender-ID hygiene.
- Sources: [TRAI Feb 2025 Regulation (official PDF)](https://www.trai.gov.in/sites/default/files/2025-02/Regulation_12022025.pdf), [TRAI's Crackdown on Spam Calls and AI-Driven Telemarketing — Chambers](https://chambers.com/articles/trai-s-crackdown-on-spam-calls-and-ai-driven-telemarketing), [TRAI DND & DLT Compliance — AI Outbound 2026](https://www.caller.digital/blog/trai-dnd-compliance-ai-outbound-calling-india), [TRAI Feb 2025 amendment and Voice AI](https://rootle.ai/blog/the-february-2025-trai-amendment-voice-ai-compliance/), [TRAI tightens spam rules Sep 2026](https://officenewz.com/2026/09/18/trai-tightens-spam-call-rules-new-norms-for-ai-automated-and-robocalls/)

See `COMPLIANCE.md` for the full non-legal-advice summary and the explicit disclaimer required by the master spec.

---

## 7. Expanded telephony-provider sweep — researched 2026-09-21 (founder-requested follow-up #2)

Founder pushed back on a Plivo-or-Exotel-only telephony choice and asked for a wide sweep of affordable India voice telephony options, evaluated the same way STT/TTS/LLM already are: swappable adapters, ranked by verified cost, with real-time bidirectional streaming media as a hard gate (not just IVR/recording/webhook callbacks). All findings below are from live web search on 2026-09-21; direct fetches to several vendor pricing pages (plivo.com) were blocked by this environment's egress proxy, so vendor-site numbers below are as captured in third-party/aggregator search snippets and vendor marketing copy indexed by search — **treat every rate as needing a final vendor-console/sales confirmation before Phase 2 commits code to a specific adapter**, same caveat as §1.

**Hard filter applied**: a provider that only offers call recording, post-call transcription, basic IVR/XML flows, or webhook callbacks — without a live, bidirectional audio WebSocket (or equivalent low-latency media stream) that a bot can both read from and write to *during* the call — cannot support this platform's real-time conversational AI pipeline. Such providers are flagged explicitly and excluded from the ranked list in STACK_PROPOSAL.md, regardless of how cheap they are.

### 7.1 Plivo — re-verified, now with a confirmed rate
- **Pricing (confirmed this pass)**: **₹0.60/min** for India voice (SIP trunking, inbound and outbound), per-second billing, no minimum spend/contract. Streaming add-on remains **$0.004/min (~₹0.35/min)** as recorded in §1.1. Combined telephony cost ≈ **₹0.95/min** — this matches the Phase 0 *benchmark estimate* almost exactly, which is a useful cross-check that the earlier ₹0.60 assumption was reasonable, but this is still a search-snippet figure, not a console/sales-confirmed quote.
- **Streaming**: confirmed (§1.1, unchanged).
- **DLT/DND**: unchanged from §1.1 — compliance responsibility sits mostly with the customer.
- Sources: [Plivo India Voice API Pricing](https://www.plivo.com/voice/pricing/in/), [Plivo SIP Trunking Pricing India](https://www.plivo.com/sip-trunking/pricing/in/), [Plivo Pricing guide 2026 — CloudTalk](https://www.cloudtalk.io/blog/plivo-pricing/)

### 7.2 FreJun Teler — new cheapest verified streaming-capable option found
- **Pricing**: **₹0.15/min outbound, ₹0.10/min inbound**, **₹0.15/min media-streaming add-on**, ₹0.04/min optional recording/storage. Channels billed at ₹600/channel/month, **minimum 10 channels** to go to production. Numbers procured in batches of 20, **minimum 12-month commitment**, requires 5 Aadhaar cards submitted per 20 DIDs (KYC-heavy but not enterprise-only — a funded startup can meet this). First 3,000 minutes free (~₹450 of credit).
- **Streaming**: confirmed — "raw WebSocket streaming that works with any AI stack," explicitly marketed for building voice-AI agents (Pipecat-compatible per their own comparison content).
- **DLT/DND**: marketed as handled natively (DLT registration, DND scrubbing, consent management) rather than left to the customer — a genuine differentiator if confirmed in a sales call, since Plivo/Exotel push more of this burden onto the tenant.
- **Caveat**: FreJun/Teler is a smaller, newer India CPaaS brand than Plivo/Exotel/Tata — less production track record than the incumbents, and the founder should sanity-check uptime/SLA and support responsiveness with a paid pilot before routing production traffic, not just trust the marketing numbers.
- Sources: [FreJun Pricing — Dialer and Teler Voice API Plans](https://frejun.com/pricing/), [FreJun India Pricing Models](https://knowledge.frejun.com/frejun-india-plans-and-pricing), [FreJun SIP Trunk Providers guide](https://frejun.com/sip-trunk-providers-india/), [FreJun Voice API India guide](https://frejun.com/teler-blog/voice-api-india/)

### 7.3 Exotel — unchanged from §1.2
- Still no public per-minute rate; third-party estimate ₹0.60–₹1.80/min depending on route. Streaming confirmed via AgentStream. See §1.2 for full detail; not re-verified further in this pass since nothing new was found.

### 7.4 Tata Tele Business Services / Smartflo
- **Pricing**: no single clean per-minute API rate found; blended estimate from aggregators is **₹0.40–₹0.80/min** for outbound. Their bundled "Cloudphone" channel plans show incremental per-minute rates of ₹0.30–₹0.50/min once a plan's included minutes are used, on top of a ₹500–₹850/channel/month rental — i.e. it is priced more like a PBX/contact-center product than a pure metered voice API, so a true apples-to-apples ₹/min number needs a sales quote for the Voice-Streaming-specific API tier.
- **Streaming**: **confirmed directly from Tata's own developer docs** — a documented "SOP for Voice Streaming" describes genuine bidirectional low-latency audio over WebSocket, 8kHz μ-law (PCMU) both directions, with static or dynamic per-call WebSocket endpoint configuration — architecturally equivalent to Plivo's `<Stream>`/Exotel's AgentStream. This is a real, usable option, not just IVR.
- **DLT/DND**: as a licensed telecom operator (not just a CPaaS reseller), Tata Tele has direct DLT/TRAI registration infrastructure and markets compliance tooling for BFSI/enterprise customers; exact self-serve tooling for a startup-scale AI calling tenant needs a sales conversation.
- **Verdict**: viable, streaming-confirmed, but pricing requires a sales quote to pin down for the Voice Streaming API tier specifically (not just the generic Cloudphone plans found).
- Sources: [Smartflo Voice Streaming SOP](https://docs.smartflo.tatatelebusiness.com/docs/copy-of-standard-operating-procedure-sop-for-voice-streaming), [Tata Smartflo pricing 2026 — itforsme](https://www.itforsme.in/pricing/tata-smartflo-india), [Building an Agentic AI Calling System with Tata Smartflo](https://medium.com/@chaubeydeepak903/building-an-agentic-ai-calling-system-with-tata-smartflo-twilio-and-exotel-6d9b498a08a5)

### 7.5 Servetel / Acefone — streaming confirmed, pricing requires sales contact
- Servetel is marketed (per one comparison source) as "by Acefone" — Acefone is the underlying platform/brand. Acefone publishes a dedicated **"Voice Streaming API for AI Voice Bots"** product page and its own **"SOP for Voice Streaming"** developer doc (structurally similar to Tata Smartflo's, suggesting shared/adjacent underlying infrastructure vendors in this space) describing genuine bidirectional real-time audio streaming — the bot can interrupt, ask follow-ups, and handle live responses without call drops.
- **Pricing**: **no public per-minute rate found** for the Voice Streaming API specifically — Acefone's own pricing page routes to a custom quote ("once their team gets a hold of your requirements, they can share a tailored subscription plan"). Servetel's base plans start ~₹999/month but that is for basic cloud-telephony/IVR, not confirmed to include the streaming API tier. **Marked "pricing requires sales contact, no public rate" per the task's rule — no number is guessed here.**
- **Streaming**: confirmed.
- **DLT/DND**: not confirmed in this search; needs direct follow-up.
- Sources: [Acefone Voice Streaming API](https://www.acefone.com/products/voice-streaming/), [Acefone Voice Streaming SOP](https://docs.acefone.in/docs/standard-operating-procedure-sop-for-voice-streaming), [Acefone AI Voice Bot Pricing](https://www.acefone.com/pricing/ai-voice-bot/), [Servetel overview — SoftwareSuggest](https://www.softwaresuggest.com/servetel)

### 7.6 Ozonetel — likely streaming-capable, not conclusively confirmed from Ozonetel's own technical docs
- Ozonetel markets "Voice AI Agents" and a voicebot-integration product, and third-party comparison content (caller.digital, ElevenLabs' own Ozonetel integration page) describes bidirectional-streaming-style architecture similar to Exotel's AgentStream. However, this search did **not** turn up Ozonetel's own primary technical documentation (equivalent to Tata's or Acefone's public "SOP for Voice Streaming" pages) spelling out the exact WebSocket/audio-format contract.
- **Pricing**: subscription-tiered ($25–$55/agent/month) plus usage-based call-minute charges; **no confirmed India per-minute voice rate** found — needs a sales quote.
- **Verdict**: plausible streaming candidate (ElevenLabs itself lists a direct Ozonetel integration, which is a meaningful signal), but **flagged as "streaming capability needs a hands-on technical confirmation before adoption"** rather than fully confirmed like Plivo/Exotel/Tata/Acefone/FreJun.
- Sources: [Connect Ozonetel to ElevenLabs AI Voice Agents](https://elevenlabs.io/agents/integrations/ozonetel), [Ozonetel Voice AI Agents](https://ozonetel.com/voice-ai-agents/), [Ozonetel Pricing guide 2026 — CloudTalk](https://www.cloudtalk.io/blog/ozonetel-pricing/)

### 7.7 Knowlarity (SuperReceptionist) — EXCLUDED: no confirmed real-time streaming
- **Pricing**: agent-license model (₹1,999–₹3,499/agent/month) plus outbound minute charges estimated at ₹0.40–₹0.80/min by aggregators; DIDs ₹500–₹2,500/month extra. No confirmed India per-minute API-only rate.
- **Streaming**: **not confirmed anywhere in this search.** Knowlarity's public developer reference (developer.knowlarity.com) and marketing pages describe IVR, click-to-call, virtual numbers, call recording, and a "voicebot"/"AI bots" product line, but no public documentation surfaced describing a bidirectional real-time audio WebSocket contract analogous to Plivo's `<Stream>`, Exotel's AgentStream, or Tata/Acefone's Voice Streaming SOPs.
- **Verdict**: **excluded from the viable/streaming-capable ranked list.** This does not mean Knowlarity definitely cannot do it — SuperReceptionist is primarily an IVR/call-center/virtual-receptionist product, and their "voicebot" may turn out to be scripted-IVR-style rather than live bidirectional audio — but absent public confirmation, it cannot be assumed to support the real-time conversational pipeline this platform needs. A direct sales/technical conversation would be needed before reconsidering it.
- Sources: [Knowlarity Pricing](https://www.knowlarity.com/pricing/voice), [Knowlarity API Reference](https://developer.knowlarity.com/), [Knowlarity — Techjockey 2026](https://www.techjockey.com/detail/knowlarity-superreceptionist)

### 7.8 Airtel IQ — EXCLUDED (for now): no confirmed real-time audio-streaming API for PSTN voice bots
- **Pricing**: pay-as-you-go, usage-dependent; no public per-minute voice rate found — sales-quote only.
- **Streaming**: Airtel IQ's public API docs and GitHub samples found in this search cover **call-flow/IVR APIs** (`callflow-component-apis`), one-to-one **video/WebRTC calling** (Room/Stream concepts for in-app video, not PSTN voice bots), and click-to-call. No public documentation was found describing a bidirectional raw-audio WebSocket for a live PSTN voice AI agent, comparable to what Plivo/Exotel/Tata/Acefone publish. Airtel IQ does list third-party "voicebot" partner solutions (e.g. VoiceGenie) in its partner marketplace, which suggests *some* path to voice AI exists, but that appears to route through a partner's own infrastructure rather than a first-party Airtel IQ streaming-media API.
- **Verdict**: **excluded from the confirmed-streaming list pending direct technical confirmation.** Cost alone would not matter here even if cheap, since the core real-time-audio requirement is unverified.
- Sources: [Airtel IQ API Docs — Call Flow Component APIs](https://www.airtel.in/business/b2b/airtel-iq/api-docs/voice/callflow-component-apis), [Airtel IQ Partner Listing (VoiceGenie)](https://www.airtel.in/business/b2b/airtel-iq-partner-listing/wa-voicebotsolution/?icid=orir&id=25), [Airtel Business Voice API blog](https://www.airtel.in/b2b/insights/blogs/what-is-programmable-voice-api-and-how-does-it-work/)

### 7.9 MyOperator — EXCLUDED: IVR/call-center product, no confirmed streaming
- **Pricing**: tiered plans ₹2,500–₹55,000/month plus ~₹0.80/min calling cost "including IVR service time," AI-agent add-on ₹10,000/agent.
- **Streaming**: **not confirmed.** All public material found describes IVR, call routing, call recording, call logs, and a general-purpose integration API for pulling call data — not a live bidirectional audio WebSocket. This reads as a traditional cloud-PBX/call-center product, not a real-time voice-AI media platform.
- **Verdict**: **excluded** — positioned for human-agent call centers with IVR front-ends, not real-time AI voice streaming. Cost is moot given the missing capability.
- Sources: [MyOperator Pricing](https://myoperator.com/pricing), [MyOperator Pricing breakdown — Bonvoice](https://bonvoice.com/insights/myoperator-pricing/)

### 7.10 Twilio (India) — comparison/global-fallback, confirmed streaming, not cost-competitive for India-only volume
- **Pricing**: India voice ≈ **₹0.35/min inbound, ₹0.65/min outbound** (landline) or, in USD terms, ~$0.0045/min inbound / $0.0075/min outbound to Indian mobiles (~₹0.40 / ₹0.66 at ₹88/$1). Indian phone numbers $2/month.
- **Streaming**: confirmed — Twilio's `<Stream>` / Media Streams is the original version of the same bidirectional-WebSocket pattern Plivo/Exotel later adopted; extremely well-documented, Pipecat has first-party Twilio support.
- **Verdict**: technically excellent and well-proven, and its raw India voice rate is actually competitive with Plivo's — but Twilio is a global platform without India-specific DLT/DND/TRAI compliance tooling built for the Indian regulatory regime the way an India-licensed OSP is, and settlement/billing is USD-denominated (FX risk). Kept as the **documented global-fallback/comparison alternate**, not promoted into the India-primary ranking.
- Sources: [Twilio Voice Pricing 2026 guide — Edesy](https://edesy.in/blog/twilio-voice-pricing-guide-2026), [Twilio Voice Pricing docs](https://www.twilio.com/docs/voice/pricing)

### 7.11 Direct SIP trunk (Airtel Business / Jio / Tata Communications / BSNL)
- All four offer enterprise SIP trunking (Jio scaling 10–5,000 concurrent sessions, Airtel over dedicated fiber/MPLS with 99.9% uptime SLA). **No self-serve, published per-minute API pricing was found for any of them** — these require a direct enterprise sales relationship, minimum channel/session commitments, and typically a dedicated circuit or MPLS link, not a signup-and-get-an-API-key flow.
- **Realistic assessment for a startup**: **not a Phase 1/2 option.** These trunks are built for enterprises already running their own PBX/SBC infrastructure and negotiating volume contracts — there is no lightweight adapter to build against without first signing a business-grade telecom contract (KYC, dedicated circuit provisioning lead time, minimum revenue commitments). This is the "enterprise-only" tier the task asked to flag as distinct from the CPaaS options above (Plivo/FreJun/Exotel/Tata Smartflo/Acefone), which all offer instant self-serve API signup on top of exactly this kind of underlying carrier infrastructure. Revisit direct SIP only once call volume is large enough (likely 100K+ min/month) to justify the sales cycle and negotiate a rate meaningfully below the CPaaS layer's markup.
- Sources: [Jio SIP Trunk](https://www.jio.com/business/services/voice-and-collaboration/sip-trunk/), [Airtel SIP Trunk](https://www.airtel.in/b2b/sip-trunk), [Best SIP Trunk Providers India 2026 — didlogic](https://didlogic.com/blog/best-sip-trunk-provider-india/)

### 7.12 Kaleyra, Route Mobile, Karix — skipped per task instructions (no findable public per-minute voice-streaming pricing)
- Kaleyra: one comparison source explicitly states its "WebSocket audio streaming support for real-time AI voice agents is limited," and no public per-minute India voice rate was found — both a capability caveat and a pricing gap. Not adopted.
- Route Mobile / Karix: no findable public per-minute voice pricing or streaming-capability documentation surfaced in this search. Per the task's instruction to skip these if pricing isn't findable, they are **not** added to the ranked list; a direct sales inquiry would be needed to evaluate either further.
- Sources: [Kaleyra alternatives — Rich Automate 2026](https://richautomate.in/blog/kaleyra-alternative-india-2026)

**Net verdict for §7**: **FreJun Teler is the cheapest confirmed streaming-capable India option found** (≈₹0.28/min for voice+streaming vs. Plivo's ≈₹0.95/min), followed by Plivo (best-documented/most mainstream), then Exotel and Tata Smartflo (both streaming-confirmed but pricing requires a sales quote), then Acefone/Servetel (streaming-confirmed, pricing sales-only), then Ozonetel (plausible but technically unconfirmed), then Twilio (confirmed but not India-optimized/FX risk). Knowlarity, Airtel IQ, and MyOperator are **excluded** for lack of any public evidence of real-time bidirectional audio streaming — they read as IVR/call-center/recording products. Direct SIP trunking (Airtel/Jio/Tata Comm/BSNL) is enterprise-only and not viable for Phase 1/2. See `STACK_PROPOSAL.md` for the resulting ranked adapter list and `COST_MODEL_V1.md` for the recomputed Economy-tier figure using FreJun Teler's verified rate.

---

## 8. Alternative/affordable providers — researched 2026-09-21 (founder-requested follow-up)

Founder asked specifically about "voicebox," plus a broader sweep of affordable/alternative STT/TTS/LLM-realtime options against the "human-like, cheap, streaming-capable" bar. Findings below; **none displace the Plivo/Sarvam/Gemini/Pipecat default**, for the reasons stated per item, but two (Smallest.ai, Bhashini) are worth tracking as future swappable alternates.

### 8.1 "Voicebox" — verdict: NOT a viable commercial option, for any of the products the name refers to
There are at least three unrelated things called "Voicebox," and none is a usable hosted TTS/voice-AI API for this platform:
- **Meta's Voicebox** (2023 research paper, "Text-Guided Multilingual Universal Speech Generation at Scale"): Meta explicitly **did not release the model or code**, citing voice-cloning/misuse risk, and published only a paper, audio samples, and a deepfake-detection classifier. **No commercial API exists from Meta.**
- **`jamiepine/voicebox` / VoiceBox.sh**: an open-source, **local-only** voice-cloning/dictation app (wraps 7 different local TTS engines). No hosted API/pricing model relevant to a cloud calling platform; would require self-hosting + GPU and is aimed at individual desktop use, not a multi-tenant telephony pipeline.
- **"Voicebox" per Stork.AI / SoftwareWorld review listings**: these describe an unrelated **voicemail-transcription/business-phone-system** product category, not a TTS/STT engine — a naming collision, not a lead.
- **Conclusion**: drop "voicebox" from further evaluation; it does not refer to a usable STT/TTS API in any form.
- Sources: [Meta Voicebox announcement](https://ai.meta.com/blog/voicebox-generative-ai-model-speech/), [Meta Voicebox research paper](https://ai.meta.com/research/publications/voicebox-text-guided-multilingual-universal-speech-generation-at-scale/), [Engadget on Voicebox non-release](https://www.engadget.com/metas-voicebox-ai-is-a-dall-e-for-text-to-speech-150021287.html), [jamiepine/voicebox (GitHub)](https://github.com/jamiepine/voicebox), [VoiceBox.sh explainer](https://daveswift.com/voicebox/), [Stork.AI Voicebox listing](https://www.stork.ai/en/voicebox)

### 8.2 Smallest.ai (Indian TTS/STT/voice-agent startup) — promising, track as an alternate
- **TTS pricing**: ~$0.0135 per 1,000 characters (~$13.50/M chars) — cheaper than Cartesia's low end and well below ElevenLabs, though not as cheap as Sarvam Bulbul's ~$3.60/M chars.
- **Streaming**: confirmed WebSocket/SSE streaming support, positioned specifically for low-latency voice agents.
- **Verdict**: genuinely affordable and India-based, but **not verified as cheaper than Sarvam Bulbul** for the Economy tier, and its Indian-language depth/production track record is less proven in this search than Sarvam's. Worth a hands-on quality/latency eval as a second Indian-language TTS alternate (in addition to Cartesia/ElevenLabs/Piper), not a primary-swap candidate yet.
- Sources: [Smallest.ai Pricing](https://smallest.ai/pricing), [Smallest.ai fastest TTS APIs 2026](https://smallest.ai/blog/top-fastest-text-to-speech-apis-in-2026)

### 8.3 Neuphonic — not cheaper, but note the latency figure
- **Pricing**: subscription-tiered — Free (limited concurrency), Business $79/mo ($948/yr) for full features incl. voice cloning, Enterprise custom. Not a pure pay-per-character model, so it doesn't map cleanly onto this cost model's ₹/min structure at low volume.
- **Latency**: sub-25ms time-to-first-audio via WebSocket — faster than Cartesia's Sonic Turbo (~40ms) on paper.
- **Verdict**: interesting for a future latency-critical Premium option, but the flat monthly-subscription pricing (vs. usage-based) makes it a worse fit than Cartesia for this platform's per-minute-metered billing model at Phase 1 scale. Not adopted.
- Sources: [Neuphonic official site](https://www.neuphonic.com/), [Neuphonic API Evangelist profile](https://github.com/api-evangelist/neuphonic), [Pipecat Neuphonic TTS service](https://docs.pipecat.ai/server/services/tts/neuphonic)

### 8.4 Rime AI — not cheaper for this volume profile
- **Pricing**: usage-based, Starter plan from $0.03/1,000 chars (Mist) or $0.05/1,000 chars (Coda) → **$30–$50/M chars**, in ElevenLabs' price range, not Sarvam/Smallest's.
- **Streaming**: sub-100ms latency, 600+ voices, 50+ languages.
- **Verdict**: a legitimate Premium-tier quality alternate (similar positioning to Cartesia/ElevenLabs) but not an affordability win — not adopted as primary or as a new Economy alternate.
- Sources: [Rime Pricing](https://www.rime.ai/pricing), [Rime updated pricing](https://rime.ai/resources/new-pricing)

### 8.5 Bhashini (Government of India digital public infrastructure) — promising for Economy/compliance-sensitive tenants, needs a hands-on integration check
- **Two distinct offerings, do not conflate them**: (a) the **government platform** at bhashini.gov.in offers ASR/TTS/NMT across 22 scheduled Indian languages, **free for non-commercial use** with discounted commercial rates; (b) a **separate commercial entity, Bhashini.ai**, sells subscription tiers (e.g. ~₹250/month for 50,000 TTS characters/day) unrelated to the government's free-tier terms.
- **Streaming**: not confirmed in this search — Bhashini's API design (ULCA-based, documented on GitBook) is oriented around request/response inference calls; real-time low-latency streaming for a live barge-in pipeline is **unconfirmed and must be tested directly** before relying on it.
- **Verdict**: worth a Phase 1 technical spike given the free/very-low-cost government tier and India-language coverage, but **not adopted as primary or alternate yet** — streaming capability and production reliability are unverified, unlike Sarvam's confirmed Pipecat-integrated streaming.
- Sources: [Bhashini government platform](https://bhashini.gov.in/ulca), [Bhashini APIs overview (GitBook)](https://bhashini.gitbook.io/bhashini-apis), [Bhashini.ai pricing](https://www.bhashini.ai/pricing), [Open-source voice AI India 2026 — Sarvam/AI4Bharat/Bhashini comparison](https://caller.digital/blog/open-source-voice-ai-india-sarvam-ai4bharat-bhasini-2026)

### 8.6 OpenAI Realtime API (speech-to-speech, LLM+voice combined) — not adopted, architecture mismatch and cost
- **Pricing**: token-based, not per-minute; GPT-Realtime-2.1 works out to roughly **$0.05/min** (audio output-dominated), GPT-Realtime-Mini roughly $0.016/min, a newer GPT-Live-1 front-end layer is a flat $0.05/min ($3/hr).
- **Architecture mismatch**: this is a combined STT+LLM+TTS speech-to-speech model, not a swappable single-layer adapter — adopting it would mean bypassing the Telephony→STT→LLM→TTS adapter-per-layer design this platform's spec mandates, trading flexibility (and Indian-language/Hinglish quality, unproven for OpenAI Realtime) for one all-in-one vendor.
- **Cost**: ~$0.05/min ≈ ₹4.4/min for the audio/voice layer alone is markedly more expensive than the Economy tier's entire current stack (~₹1.08/min for STT+TTS+LLM combined).
- **Verdict**: not adopted. Worth revisiting only for a possible future "instant premium, zero-config" tier where the flexibility trade-off is acceptable, not for Economy or Premium as currently modeled.
- Sources: [OpenAI Realtime API pricing breakdown](https://www.forasoft.com/blog/article/openai-realtime-api-pricing), [GPT Realtime Mini pricing 2026](https://www.eesel.ai/blog/gpt-realtime-mini-pricing)

### 8.7 Azure Speech, AWS Polly/Transcribe, Google Cloud STT/TTS — viable but not cheaper than the current picks
- **Azure**: STT ~$1/audio-hour (~₹1.47/min) standard; TTS Neural $16/M chars, Neural HD $22/M chars (down from $30 in Mar 2026). Free tier: 500K TTS chars + 5 STT hours/month, permanent.
- **AWS**: Transcribe streaming $0.030/min (~₹2.64/min); Polly Standard $4/M chars, Neural $16/M chars, Generative $30/M chars.
- **Google Cloud**: STT from $0.016/min (~₹1.41/min); TTS pricing tiered similarly to Azure/AWS (standard vs. neural/studio voices).
- **Verdict**: all three are mature, reliable, global-scale options with genuine streaming support, but **none beats Sarvam's ₹0.50/min STT or ₹30/10,000-chars TTS on cost, and none has Sarvam's confirmed Hindi/Hinglish code-switching strength**. They remain credible alternates for English-heavy or non-Indian-market expansion (the adapter pattern already supports adding them without a core change) but are not proposed as new primaries or Economy alternates.
- Sources: [AWS/Azure/Google STT-TTS pricing comparison](https://vocafuse.com/blog/best-speech-to-text-api-comparison-2025/), [Azure Speech pricing 2026](https://texttolab.com/blog/azure-text-to-speech-pricing), [TTS pricing comparison 2026 (11 providers)](https://offlinetts.com/blog/tts-pricing-comparison-2026/)

### 8.8 Coqui/XTTS (self-hosted) and Vosk (self-hosted STT) — status check, both technically alive but neither displaces Piper/Sarvam
- **Coqui/XTTS v2**: Coqui the company shut down in Jan 2024; the codebase is community-maintained (active fork: `idiap/coqui-ai-TTS`, published as `coqui-tts` on PyPI). **Licensing caveat**: the pretrained XTTS v2 model weights are under the Coqui Public Model License (CPML) — **non-commercial only** — so using the public weights in this commercial SaaS is not viable without either training/licensing a commercial model or restricting to voices with a compatible license. This is a harder license blocker than Piper's GPL-3.0 (which at least permits commercial use with copyleft obligations); not recommended as a self-hosted alternate given this constraint.
- **Vosk**: actively maintained (updated Mar 2026), offline/self-hosted, CPU-only, streaming-capable, 20+ languages, small footprint (~50MB models) — a legitimate self-hosted STT fallback for cost-sensitive or data-residency-sensitive deployments, comparable in spirit to the Piper self-hosted TTS option. Recommend noting it alongside Piper as a documented (not primary) self-hosted Economy/data-residency fallback for STT, same caveat as Piper: real ops overhead, evaluate only once volume justifies it.
- Sources: [Coqui/XTTS v2 CPML license guide 2026](https://www.promptquorum.com/power-local-llm/local-tts-voice-cloning-piper-coqui-xtts), [idiap/coqui-ai-TTS (GitHub)](https://github.com/idiap/coqui-ai-TTS), [Vosk vs Whisper Local 2026 guide](https://www.sinologic.net/en/2026-05/vosk-vs-whisper-local-the-ultimate-2026-guide-to-self-hosted-speech-recognition-stt.html), [Vosk official](https://alphacephei.com/vosk/)

**Net verdict for §8**: the Plivo/Sarvam/Gemini/Pipecat default stack still wins on the "cheap + human-like + streaming + Indian-language-proven" combination. Smallest.ai and Bhashini are the two most worth a hands-on technical spike in Phase 1 as documented alternates (Smallest.ai for TTS cost/quality, Bhashini for a possible free/near-free Economy-tier STT/TTS path pending streaming confirmation) — both added to `STACK_PROPOSAL.md`'s notes column as "watch" items, not yet promoted to the primary/alternate table since neither has a Pipecat-confirmed streaming integration verified in this session the way Sarvam/Deepgram/Cartesia do.

---

## 9. Open items to re-verify before Phase 1 build starts

1. Plivo's ₹0.60/min India rate was found via search snippet in the 2026-09-21 follow-up (§7.1) but direct fetch to plivo.com was still blocked by this environment's egress proxy — confirm via console login or sales contact before final commitment.
2. Exact current Exotel India per-minute voice rate (Exotel does not publish; needs a sales quote).
3. FreJun Teler's ₹0.15/₹0.10/₹0.15-per-min (outbound/inbound/streaming) rates and native DLT/DND-handling claim (§7.2) — confirmed only via search-indexed vendor marketing pages, not a sales call or paid pilot; verify uptime/SLA and support track record given it is a newer, smaller brand than the incumbents, before routing production traffic.
4. Tata Smartflo's and Acefone/Servetel's Voice Streaming API per-minute pricing (both confirmed technically streaming-capable in §7.4/§7.5, but pricing requires a direct sales quote — not found publicly).
5. Ozonetel's own first-party bidirectional-streaming technical documentation (§7.6) — plausible via third-party/partner signals (ElevenLabs integration) but not confirmed from Ozonetel's own docs the way Tata/Acefone/Plivo/Exotel are.
6. A direct technical/sales confirmation for Knowlarity and Airtel IQ on whether either has *any* first-party bidirectional real-time audio-streaming API — both were excluded in §7.7/§7.8 for lack of public evidence, but that is an evidence gap, not a confirmed "no."
7. Confirm active Sarvam STT model name (Saarika v2.5 → Saaras v3 migration) and its current per-minute pricing at integration time.
8. Confirm Gemini's post-2026-10-16 successor model name/pricing (2.5 Flash-Lite/Flash are being retired within weeks of this document).
9. Confirm whether Groq Llama 3.3 70B enterprise pricing is reachable/affordable for this project's volume, or whether 3.1-8B-Instant (or another vendor) should be the sole Groq-hosted alternate.
10. Get written confirmation from Plivo/Exotel/FreJun/Tata/Acefone on their DLT-registration-assist and DND-scrubbing tooling specifically for AI/bot-originated outbound calls (not just human agent call centers).
11. Legal review of Piper's GPL-3.0 relicensing (post Oct 2025) and per-voice-model license terms before using it as a self-hosted TTS in a commercial SaaS.
12. Hands-on Phase 1 spike: confirm whether Bhashini's government-tier API supports real-time streaming ASR/TTS suitable for a live barge-in call (unconfirmed in §8.5) — if yes, it's a candidate free/near-free Economy STT/TTS alternate for Indian-language tenants.
13. Hands-on Phase 1 eval: Smallest.ai TTS quality/latency/Hinglish-handling head-to-head against Sarvam Bulbul (§8.2) — decide whether it's worth adding as a documented alternate.

---

## 10. Phase 3 re-verification pass — 2026-09-21 (STT/TTS/LLM build kickoff)

Before implementing `services/voice-gateway`'s STT/TTS/LLM adapters, per the
task's instruction to reconfirm current API shape/model availability
(quick pass, not a full Phase 0 redo — most pricing/vendor findings above
already hold from the same-day §7/§8 research). Findings that CHANGED a
concrete decision are called out explicitly; everything else confirmed the
existing plan.

- **Gemini model naming — changed the adapter's approach, not just a
  number.** Open items #8 above asked to "confirm Gemini's post-2026-10-16
  successor model name/pricing." Re-checking: Google documents rolling
  aliases `gemini-flash-latest` / `gemini-flash-lite-latest` that always
  resolve to the current non-deprecated build of that tier (Google gives
  ~2 weeks' notice before an alias moves to a new underlying model). Rather
  than pin a dated successor string that would just repeat this exact
  problem at the next retirement (2.5 Flash-Lite/Flash → the task's own
  cited 3.1/3.5 successors were themselves *more expensive* per-token, per
  §4.1 above, meaning even "the current best pick" churns), the
  `llm.gemini_flash_lite` / `llm.gemini_flash` adapters
  (`voice_gateway/llm/adapters/gemini.py`) default to these rolling aliases.
  A tenant needing a pinned, contractually-stable model for cost
  predictability can still override `tenant_provider_config.config.model`
  with a dated string — this is a config default, not a hard constraint.
- **Groq Llama — confirmed §4.2's conclusion, no change.** `llama-3.1-8b-instant`
  remains self-serve at the OpenAI-compatible `api.groq.com/openai/v1/chat/completions`
  endpoint; `llama-3.3-70b` remains enterprise/contact-sales only (as of the
  2026-08-26 change already recorded in §4.2). Adapter targets 3.1-8B.
- **Sarvam STT — model name confirmed, endpoint detail added.** §2.1/§9.7
  already flagged the Saarika v2.5 → Saaras v3 migration; this pass found
  the specific realtime-streaming detail needed to actually implement it:
  the streaming endpoint is `wss://api.sarvam.ai/speech-to-text/ws`,
  defaulting to `saaras:v3-realtime` (with `saaras:v4-realtime` also
  available on the same endpoint/protocol). No pricing change found.
- **Deepgram, Cartesia, ElevenLabs, Piper** — no new findings changed
  anything from §2/§3; adapters implement the API shapes already described
  there (Deepgram Nova-3 WebSocket, Cartesia Sonic-3 WebSocket, ElevenLabs
  HTTP streaming, Piper as a self-hosted HTTP wrapper with the GPL-3.0
  caveat repeated verbatim from §3.4 in
  `services/voice-gateway/voice_gateway/tts/adapters/piper.py` and in
  `db/migrations/008_stt_tts_llm_providers.sql`'s `providers` row for it).
- **Groq-hosted Whisper** — confirmed as a genuinely real, self-serve
  product (§2.3's finding holds), and confirmed it is a *batch/REST*
  endpoint (`POST api.groq.com/openai/v1/audio/transcriptions`,
  `whisper-large-v3-turbo`), not a live streaming socket — the
  `stt.groq_whisper` adapter implements the STTProvider streaming interface
  by buffering and transcribing once per utterance (see that adapter's
  docstring), exactly the "cost-optimized fallback, not primary live-turn
  STT" role §2.3 already assigned it. Self-hosted faster-whisper was not
  additionally implemented as a fourth STT adapter for this phase (Sarvam/
  Deepgram/Groq Whisper/Mock cover the task's explicit adapter list); it
  remains a documented option per §2.3 if a future phase needs it.

No other pricing figures in this document needed re-verification for this
build — see `services/voice-gateway/README.md`'s "Model-name / pricing
re-verification" section for how these findings map onto the actual
adapter code and the `providers` catalog rows.

## §10 — Phase 6: WhatsApp Business API for a small Indian startup (2026-09-22)

Researched via WebSearch on 2026-09-22 for the Phase 6 WhatsApp provider
registry. Question: for a small Indian startup, official Meta Cloud API
direct, or a Business Solution Provider (BSP)?

### 10.1 Meta's own pricing (the floor every option pays)

Meta moved WhatsApp Business Platform pricing from conversation-based to
**per-message** pricing during 2025, and revised India marketing-template
rates upward again in July 2026 (~₹0.7846 → ~₹0.8631 per marketing
message; utility messages sent outside the free 24h customer-service
window are far cheaper, ~₹0.115 each). **From 1 October 2026, Meta begins
charging per-message for service/utility messages sent inside the
previously-free 24h window too** — this is a live, moving cost surface a
tenant's WhatsApp spend must be re-checked against periodically, not a
one-time number. Direct Meta Cloud API access is technically available to
anyone with a verified Meta Business Manager account, but requires the
tenant/platform to build and operate webhooks, message-template
management, retry/rate-limit handling, and delivery-status tracking
in-house — real engineering cost for a small team, not just API pricing.

### 10.2 BSP landscape (2026 snapshot)

| BSP | Pricing model found | Notes |
|---|---|---|
| **Interakt** | Publishes per-conversation pricing on every tier (e.g. ~₹0.970/marketing message on its Starter tier, ~₹0.949 on Advanced); service messages free across tiers; official Meta BSP | Most transparent published pricing of the group; fast, well-documented small-business onboarding path |
| **AiSensy** | Entry plan from ~₹999-1,500/month, lowest published entry price of the group | Strongest marketing/broadcast focus; good fit if bulk WhatsApp marketing (not just transactional/CRM-triggered sends) is a priority |
| **WATI** | ~₹2,499/month tier found | Comparable feature set to Interakt/AiSensy; slightly higher published entry price |
| **Gupshup** | No published tier pricing — pay-as-you-go, USD-denominated, sales-quote territory; ~₹4,000/month-equivalent cited by third-party comparisons | Enterprise-grade, owned by Tiger Global, used by large banks/fintechs — proven at scale, but overkill and less transparent for a Phase 6 startup volume |

### 10.3 Onboarding for a small Indian startup

A standard onboarding (Meta Business Manager verification + WABA creation
+ phone-number onboarding + first template approvals) takes roughly
**3-10 business days** once documents are ready: a live business website
showing the legal business name, an active Meta Business Manager with
admin access, and a phone number able to receive an SMS/voice OTP that is
**not** currently active on the free WhatsApp/WhatsApp Business consumer
app. Template message approval (required for any business-initiated
message outside a live 24h customer session) typically takes 24-48 hours
per template.

### 10.4 Verdict

**Primary: Interakt** — official Meta BSP, the most transparent published
per-conversation pricing of the group at Phase 6's likely startup volume,
and a fast onboarding path appropriate for a small team's first WhatsApp
integration. **Alternate: Gupshup** — the enterprise-grade fallback once
volume/BFSI-grade reliability requirements outgrow a small BSP; kept as
`beta` status in the `providers` catalog
(`db/migrations/011_phase6_whatsapp_appointments_campaigns_compliance.sql`)
pending a real sales quote. Direct Meta Cloud API is noted as the
long-term option once the team has engineering bandwidth to own
webhooks/templates/rate-limiting itself, but is **not** the Phase 6
recommendation for a small team — the BSP's operational overhead
reduction is worth its markup at this stage. See
`docs/STACK_PROPOSAL.md`'s new WhatsApp row for how this maps to the
`providers` catalog.

Sources: developers.facebook.com/documentation/business-messaging/whatsapp/pricing;
myoperator.com/blog/whatsapp-business-api-pricing-india-2026;
m.aisensy.com/blog/whatsapp-api-providers; codingclave.com/guides/whatsapp-api-pricing-india-2026-comparison;
codingclave.com/blog/gupshup-whatsapp-pricing-india-2026; wati.io/en/blog/whatsapp-api-prerequisites;
go4whatsup.com/guides/get-whatsapp-business-api.
