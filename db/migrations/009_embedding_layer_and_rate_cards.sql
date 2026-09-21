-- 009_embedding_layer_and_rate_cards.sql
-- Phase 3.5/4: (a) add 'embedding' as a fourth Provider Registry layer, for
-- the knowledge-base/RAG ingestion pipeline (Part C); (b) seed a couple of
-- provider_rate_cards rows so the usage/cost writer (Part B) has real rate
-- data to multiply against instead of a hardcoded number in test/dev.
--
-- Why an ALTER is needed here (unlike Phase 3's stt/tts/llm layers): per
-- docs/PROVIDER_REGISTRY.md, `providers.layer` / `tenant_provider_config.layer`
-- are a plain `text` column + `CHECK` constraint, NOT a Postgres `ENUM` type,
-- specifically so adding a layer is "a one-line CHECK edit, never ALTER
-- TYPE" (007_provider_registry.sql's own comment). Phase 3's stt/tts/llm
-- values happened to already be present in that CHECK from Phase 2, so no
-- migration was needed then. 'embedding' was NOT anticipated, so this is
-- that one-line CHECK edit the design predicted — confirming the pattern
-- works as designed, not a schema regression.

ALTER TABLE providers DROP CONSTRAINT providers_layer_check;
ALTER TABLE providers ADD CONSTRAINT providers_layer_check
  CHECK (layer IN ('telephony', 'stt', 'tts', 'llm', 'embedding'));

ALTER TABLE tenant_provider_config DROP CONSTRAINT tenant_provider_config_layer_check;
ALTER TABLE tenant_provider_config ADD CONSTRAINT tenant_provider_config_layer_check
  CHECK (layer IN ('telephony', 'stt', 'tts', 'llm', 'embedding'));

-- Seed the embedding layer's adapter catalog. `mock` (deterministic,
-- hash-based fake vectors — no network) is the default/highest-priority row
-- so tests and demo mode never need a real key, exactly like every other
-- layer's `mock` row. `gemini` is the one real adapter: Google's
-- text-embedding-004 is a current, cheap ($0.00001/1K chars-equivalent — see
-- docs/AUDIO_BRIDGE.md's sibling doc note, or Google's own pricing page,
-- for the current number, which — like the LLM Gemini adapter's model
-- name — should be re-verified before go-live) embedding model reachable
-- from the exact same Gemini API surface the llm.gemini_* adapters already
-- use, so this deployment doesn't need to onboard a whole second vendor
-- just for embeddings.
INSERT INTO providers (layer, provider_key, display_name, adapter_class_identifier, config_schema, status, default_priority, cost_notes, capabilities) VALUES
(
  'embedding', 'mock', 'Mock Embedding (demo/test)', 'embedding.mock',
  '{"required": [], "properties": {"dimensions": {"type": "integer", "default": 768}}}'::jsonb,
  'active', 1,
  'No cost — deterministic hash-based fake vectors for demo mode and automated tests. Never used for real ingestion.',
  '{"dimensions": 768}'::jsonb
),
(
  'embedding', 'gemini', 'Gemini text-embedding-004', 'embedding.gemini',
  '{"required": ["api_key"], "properties": {"api_key": {"type": "string"}, "model": {"type": "string", "default": "text-embedding-004"}}}'::jsonb,
  'active', 10,
  'Primary embedding provider for knowledge-base ingestion (Part C) — same vendor/API surface as the llm.gemini_* adapters, 768-dim output matching knowledge_chunks.embedding''s column width, and priced far below a dedicated embeddings vendor at this platform''s expected KB-ingestion volume. Re-verify current per-request pricing before go-live, same caveat as every other adapter''s cost_notes in this catalog.',
  '{"dimensions": 768, "batch": true}'::jsonb
)
ON CONFLICT (layer, provider_key) DO NOTHING;

-- provider_rate_cards seed data — used by voice_gateway/billing/cost_writer.py
-- to compute cost_records from raw UsageReport quantities instead of a
-- hardcoded rate. Figures are the same per-unit numbers already researched
-- and cited in docs/VERIFICATION.md (Sarvam STT ~₹0.50/min ≈ $0.006/min at
-- ~₹83/$1; Gemini Flash-Lite $0.10/M input tokens) — re-verify at go-live
-- per that document's own repeated caveat, same as every other price in
-- this codebase.
INSERT INTO provider_rate_cards (provider_type, provider_key, unit, unit_price_usd, notes) VALUES
('stt', 'mock', 'per_minute', 0.000000, 'Mock provider — always free, used only so cost-writer tests/demo runs have a real rate-card row to join against.'),
('llm', 'mock', 'per_1m_tokens', 0.000000, 'Mock provider — always free.'),
('tts', 'mock', 'per_1k_chars', 0.000000, 'Mock provider — always free.'),
('stt', 'sarvam', 'per_minute', 0.006000, 'docs/VERIFICATION.md §2.1: ~Rs 0.50/min ≈ $0.006/min at ~Rs 83/$1 — re-verify before billing real usage.'),
('llm', 'gemini_flash_lite', 'per_1m_tokens', 0.100000, 'docs/VERIFICATION.md §4.1: $0.10/M input tokens (input-token rate only; output priced separately in a real rate card — Phase 1 schema is one rate per provider_key/unit, a known simplification noted in docs/AUDIO_BRIDGE.md).')
ON CONFLICT DO NOTHING;
