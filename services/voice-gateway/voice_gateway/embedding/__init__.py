"""EmbeddingProvider — the fourth Provider Registry layer (Phase 3.5 Part
C), added specifically so the embedding model a tenant's knowledge-base
ingestion uses is swappable through the SAME registry pattern as
telephony/stt/tts/llm, per the founder's non-negotiable rule (see
docs/PROVIDER_REGISTRY.md).

`providers.layer` / `tenant_provider_config.layer` needed an actual `ALTER
TABLE ... DROP/ADD CONSTRAINT` for this one (see
db/migrations/009_embedding_layer_and_rate_cards.sql) — unlike stt/tts/llm,
which Phase 2's original CHECK constraint already anticipated.
"""
