"""Voice Gateway — Phase 3 real-time streaming voice pipeline service.

Separate Python runtime from apps/web (Next.js/TypeScript). Connects to the
SAME Postgres database Phase 1/2 created (no schema duplication) to resolve
per-tenant STT/TTS/LLM provider configuration via the shared
`providers` / `tenant_provider_config` tables (db/migrations/007_provider_registry.sql,
008_stt_tts_llm_providers.sql).
"""

__version__ = "0.1.0"
