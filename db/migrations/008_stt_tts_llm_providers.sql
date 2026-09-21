-- 008_stt_tts_llm_providers.sql
-- Phase 3: seed the `providers` catalog for the stt/tts/llm layers. NO
-- schema change — `providers.layer` and `tenant_provider_config.layer`
-- already accept 'stt' | 'tts' | 'llm' via the CHECK constraint added in
-- 007_provider_registry.sql, exactly as docs/PROVIDER_REGISTRY.md's
-- "Reuse in Phase 3" section anticipated. This migration only INSERTs rows.
--
-- adapter_class_identifier values below match what
-- services/voice-gateway/voice_gateway/{stt,tts,llm}/adapters/*.py
-- register via register_adapter(...) at import time (see adapter_map.py) —
-- keep these two in sync when adding a provider.
--
-- Model-name note (see docs/VERIFICATION.md's 2026-09-21 dated appendix
-- for the full re-verification pass this migration is based on): several
-- model names in cost_notes are Google's own rolling "-latest" aliases
-- (gemini-flash-latest / gemini-flash-lite-latest) rather than a pinned
-- dated model, specifically BECAUSE the pinned 2.5-generation models this
-- spec originally named are retiring 2026-10-16 — see the LLM section
-- below.

INSERT INTO providers (layer, provider_key, display_name, adapter_class_identifier, config_schema, status, default_priority, cost_notes, capabilities) VALUES

-- ---------------------------------------------------------------- STT ----
(
  'stt', 'mock', 'Mock STT (demo/test)', 'stt.mock',
  '{"required": [], "properties": {}}'::jsonb,
  'active', 1,
  'No cost — deterministic canned transcript for demo mode and automated tests. Never used for real calls.',
  '{"streaming": true, "partial_transcripts": true}'::jsonb
),
(
  'stt', 'sarvam', 'Sarvam Saaras (STT)', 'stt.sarvam',
  '{"required": ["api_key"], "properties": {"api_key": {"type": "string"}, "model": {"type": "string", "default": "saaras:v3-realtime"}, "language_code": {"type": "string", "default": "hi-IN"}}}'::jsonb,
  'active', 10,
  'Primary per docs/VERIFICATION.md §2.1/§9.7 — strongest Hindi/Hinglish code-switching quality, INR-priced (~Rs 0.50/min). Model re-verified 2026-09-21: realtime streaming lives at saaras:v3-realtime (default) / saaras:v4-realtime on the /speech-to-text/ws endpoint, superseding the older Saarika v2.5 batch model this spec originally referenced.',
  '{"streaming": true, "partial_transcripts": true, "languages": ["hi", "en", "hinglish", "+9 more Indian languages"]}'::jsonb
),
(
  'stt', 'deepgram', 'Deepgram Nova-3 (STT)', 'stt.deepgram',
  '{"required": ["api_key"], "properties": {"api_key": {"type": "string"}, "model": {"type": "string", "default": "nova-3"}, "language": {"type": "string", "default": "en"}}}'::jsonb,
  'active', 20,
  'Alternate per docs/VERIFICATION.md §2.2 — $0.0077/min PAYG streaming. English/multilingual strength; not primary for Hindi/Hinglish.',
  '{"streaming": true, "partial_transcripts": true}'::jsonb
),
(
  'stt', 'groq_whisper', 'Groq-hosted Whisper large-v3-turbo (STT)', 'stt.groq_whisper',
  '{"required": ["api_key"], "properties": {"api_key": {"type": "string"}, "model": {"type": "string", "default": "whisper-large-v3-turbo"}}}'::jsonb,
  'active', 30,
  'Alternate per docs/VERIFICATION.md §2.3 — cheapest option (~$0.04/hr), but Groq''s hosted Whisper is a batch/near-real-time REST endpoint, not a native low-latency streaming socket like Sarvam/Deepgram: used here as a cost-optimized fallback for short-utterance chunks, not the primary live-turn STT.',
  '{"streaming": false, "partial_transcripts": false, "chunked_near_realtime": true}'::jsonb
),

-- ---------------------------------------------------------------- TTS ----
(
  'tts', 'mock', 'Mock TTS (demo/test)', 'tts.mock',
  '{"required": [], "properties": {}}'::jsonb,
  'active', 1,
  'No cost — deterministic canned silence/tone audio for demo mode and automated tests. Never used for real calls.',
  '{"streaming": true}'::jsonb
),
(
  'tts', 'sarvam', 'Sarvam Bulbul v3 (TTS)', 'tts.sarvam',
  '{"required": ["api_key"], "properties": {"api_key": {"type": "string"}, "model": {"type": "string", "default": "bulbul:v3"}, "speaker": {"type": "string", "default": "anushka"}}}'::jsonb,
  'active', 10,
  'Primary per docs/VERIFICATION.md §3.1 — cheapest verified option (~Rs 30/10,000 chars), 30+ Indian-language voices, confirmed WebSocket streaming.',
  '{"streaming": true, "languages": ["hi", "en", "+9 more Indian languages"]}'::jsonb
),
(
  'tts', 'cartesia', 'Cartesia Sonic (TTS)', 'tts.cartesia',
  '{"required": ["api_key"], "properties": {"api_key": {"type": "string"}, "model": {"type": "string", "default": "sonic-3"}, "voice_id": {"type": "string"}}}'::jsonb,
  'active', 20,
  'Premium low-latency alternate per docs/VERIFICATION.md §3.2 — ~90ms time-to-first-audio, $5-37/M chars; English/global-language focus, not Hindi-first.',
  '{"streaming": true}'::jsonb
),
(
  'tts', 'elevenlabs', 'ElevenLabs (TTS)', 'tts.elevenlabs',
  '{"required": ["api_key"], "properties": {"api_key": {"type": "string"}, "voice_id": {"type": "string"}, "model_id": {"type": "string", "default": "eleven_flash_v2_5"}}}'::jsonb,
  'active', 30,
  'Premium/flagship-quality alternate per docs/VERIFICATION.md §3.3 — most expensive evaluated ($50-100/M chars), used for high-value calls only.',
  '{"streaming": true}'::jsonb
),
(
  'tts', 'piper', 'Piper (self-hosted TTS)', 'tts.piper',
  '{"required": ["base_url"], "properties": {"base_url": {"type": "string", "description": "URL of a self-hosted Piper HTTP wrapper"}, "voice": {"type": "string"}}}'::jsonb,
  'active', 40,
  'Economy self-hosted alternate per docs/VERIFICATION.md §3.4. LICENSE CAVEAT (do not ignore): active development moved to OHF-Voice/piper1-gpl, GPL-3.0 (copyleft) — the original MIT rhasspy/piper repo is archived. Running Piper as an arm''s-length internal HTTP service (this adapter''s pattern) avoids linking GPL code into proprietary code, but this is a legal question requiring counsel review before commercial use, not a purely technical one. Each voice model also carries its own separate license (some personal-use/research-only) and must be checked individually.',
  '{"streaming": true, "self_hosted": true, "license": "GPL-3.0 (engine) - REQUIRES LEGAL REVIEW - see cost_notes"}'::jsonb
),

-- ---------------------------------------------------------------- LLM ----
(
  'llm', 'mock', 'Mock LLM (demo/test)', 'llm.mock',
  '{"required": [], "properties": {}}'::jsonb,
  'active', 1,
  'No cost — deterministic canned response (including a fake tool-call, for exercising the orchestrator''s tool-dispatch path) for demo mode and automated tests. Never used for real calls.',
  '{"streaming": true, "tool_calling": true}'::jsonb
),
(
  'llm', 'gemini_flash_lite', 'Gemini Flash-Lite (simple turns)', 'llm.gemini_flash_lite',
  '{"required": ["api_key"], "properties": {"api_key": {"type": "string"}, "model": {"type": "string", "default": "gemini-flash-lite-latest"}}}'::jsonb,
  'active', 10,
  'Primary (simple turns) per docs/STACK_PROPOSAL.md. MODEL NAME CHANGED on 2026-09-21 re-verification: the spec''s originally-named Gemini 2.5 Flash-Lite retires 2026-10-16, and its dated successors (3.1/3.5 Flash-Lite) are actually MORE expensive per-token than 2.5 was. This adapter therefore targets Google''s own rolling alias gemini-flash-lite-latest (always the current non-deprecated Flash-Lite build) instead of a dated model string, specifically to survive future Google-side retirements without a code change — re-verify per-token price at billing-integration time since the alias''s underlying model (and price) can change.',
  '{"streaming": true, "tool_calling": true}'::jsonb
),
(
  'llm', 'gemini_flash', 'Gemini Flash (complex turns)', 'llm.gemini_flash',
  '{"required": ["api_key"], "properties": {"api_key": {"type": "string"}, "model": {"type": "string", "default": "gemini-flash-latest"}}}'::jsonb,
  'active', 20,
  'Primary (complex turns) per docs/STACK_PROPOSAL.md. Same rolling-alias rationale as gemini_flash_lite above (gemini-flash-latest instead of a dated, soon-to-retire 2.5 Flash model string).',
  '{"streaming": true, "tool_calling": true}'::jsonb
),
(
  'llm', 'groq_llama', 'Groq-hosted Llama 3.1 8B Instant', 'llm.groq_llama',
  '{"required": ["api_key"], "properties": {"api_key": {"type": "string"}, "model": {"type": "string", "default": "llama-3.1-8b-instant"}}}'::jsonb,
  'active', 30,
  'Alternate per docs/VERIFICATION.md §4.2. MODEL CHANGED on re-verification: Llama 3.3 70B moved to enterprise-only "contact sales" pricing on 2026-08-26 and is no longer self-serve, so this adapter targets 3.1-8B-Instant (still self-serve, $0.05/M in, $0.08/M out) as the sole Groq alternate rather than the spec''s originally-named 3.1/3.3 pairing.',
  '{"streaming": true, "tool_calling": true}'::jsonb
)

ON CONFLICT (layer, provider_key) DO NOTHING;
