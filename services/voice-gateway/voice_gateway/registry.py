"""The generic provider factory/loader — Python side of the Provider
Registry described in docs/PROVIDER_REGISTRY.md. Same contract as
apps/web/lib/providers/registry.ts's `getProvider<T>()`, against the exact
same `providers` / `tenant_provider_config` tables (no schema change, no
duplicate catalog): resolve the tenant's configured provider for a layer,
decrypt its config, look up the registered factory, instantiate it.

Zero if/else on provider identity anywhere in this file — see
docs/PROVIDER_REGISTRY.md "How to add a new provider" for the process this
proves (also exercised by tests/test_registry.py).
"""

from __future__ import annotations

from typing import Any, Literal

import asyncpg

from .adapter_map import resolve_adapter_factory
from .crypto import decrypt_provider_config, is_encrypted_config
from .db import with_tenant
from .embedding.adapters import gemini as _embedding_gemini  # noqa: F401
from .embedding.adapters import mock as _embedding_mock  # noqa: F401
from .llm.adapters import gemini as _llm_gemini  # noqa: F401
from .llm.adapters import groq_llama as _llm_groq_llama  # noqa: F401
from .llm.adapters import mock as _llm_mock  # noqa: F401

# Import every built-in adapter module once, for its side-effecting
# register_adapter() call. This import list is the ONLY place in this
# service that needs to know the built-in adapters exist — adding a new
# provider means adding one adapter file + one more line here + one
# `providers` row (db/migrations/008_stt_tts_llm_providers.sql), never
# touching the resolution logic below.
from .stt.adapters import deepgram as _stt_deepgram  # noqa: F401
from .stt.adapters import groq_whisper as _stt_groq_whisper  # noqa: F401
from .stt.adapters import mock as _stt_mock  # noqa: F401
from .stt.adapters import sarvam as _stt_sarvam  # noqa: F401
from .tts.adapters import cartesia as _tts_cartesia  # noqa: F401
from .tts.adapters import elevenlabs as _tts_elevenlabs  # noqa: F401
from .tts.adapters import mock as _tts_mock  # noqa: F401
from .tts.adapters import piper as _tts_piper  # noqa: F401
from .tts.adapters import sarvam as _tts_sarvam  # noqa: F401

Layer = Literal["telephony", "stt", "tts", "llm", "embedding"]


class ProviderNotConfiguredError(Exception):
    def __init__(self, org_id: str, layer: str):
        super().__init__(f"No {layer} provider configured for org {org_id}")


class ProviderNotRegisteredError(Exception):
    def __init__(self, identifier: str):
        super().__init__(f'No adapter registered for identifier "{identifier}" — is its module imported?')


async def get_provider(
    layer: Layer,
    org_id: str,
    user_id: str | None,
    *,
    provider_key: str | None = None,
) -> Any:
    """The ONLY sanctioned way this service obtains an STT/TTS/LLM (or
    telephony) provider. Never `from .stt.adapters.sarvam import
    SarvamSTTProvider` directly in orchestrator/business-logic code, and
    never branch on provider_key — see docs/PROVIDER_REGISTRY.md."""
    provider, _key = await get_provider_with_key(layer, org_id, user_id, provider_key=provider_key)
    return provider


async def get_provider_with_key(
    layer: Layer,
    org_id: str,
    user_id: str | None,
    *,
    provider_key: str | None = None,
) -> tuple[Any, str]:
    """Same resolution as `get_provider`, but also returns the resolved
    `provider_key` string (Phase 9: needed by the orchestrator to attribute
    a latency measurement or a failover event to the ACTUAL provider that
    was selected, not just "whatever the tenant's default is")."""

    async def _resolve(conn: asyncpg.Connection) -> tuple[Any, str]:
        row = await _load_tenant_provider_config(conn, org_id, layer, provider_key)
        if row is None:
            raise ProviderNotConfiguredError(org_id, layer)
        factory = resolve_adapter_factory(row["adapter_class_identifier"])
        if factory is None:
            raise ProviderNotRegisteredError(row["adapter_class_identifier"])
        config = _decrypt_config_if_needed(row["config"])
        return factory(config), row["provider_key"]

    return await with_tenant(org_id, user_id, _resolve)


async def list_ranked_provider_configs(
    conn: asyncpg.Connection, org_id: str, layer: str
) -> list[asyncpg.Record]:
    """Phase 9 failover: every provider configured for (org_id, layer), in
    the SAME priority order `get_provider` already uses for its single
    pick (is_default DESC, priority ASC) — this is the ranked-provider-list
    support the Phase 9 spec asked to "verify" already exists (it does,
    since Phase 2 — see 007_provider_registry.sql's `priority` column) and
    reuse rather than duplicate."""
    return await conn.fetch(
        """
        SELECT tpc.provider_key, tpc.config, p.adapter_class_identifier
          FROM tenant_provider_config tpc
          JOIN providers p ON p.layer = tpc.layer AND p.provider_key = tpc.provider_key
         WHERE tpc.org_id = $1 AND tpc.layer = $2
         ORDER BY tpc.is_default DESC, tpc.priority ASC
        """,
        org_id,
        layer,
    )


async def _load_tenant_provider_config(
    conn: asyncpg.Connection,
    org_id: str,
    layer: str,
    provider_key: str | None,
) -> asyncpg.Record | None:
    if provider_key:
        return await conn.fetchrow(
            """
            SELECT tpc.provider_key, tpc.config, p.adapter_class_identifier
              FROM tenant_provider_config tpc
              JOIN providers p ON p.layer = tpc.layer AND p.provider_key = tpc.provider_key
             WHERE tpc.org_id = $1 AND tpc.layer = $2 AND tpc.provider_key = $3
             LIMIT 1
            """,
            org_id,
            layer,
            provider_key,
        )
    return await conn.fetchrow(
        """
        SELECT tpc.provider_key, tpc.config, p.adapter_class_identifier
          FROM tenant_provider_config tpc
          JOIN providers p ON p.layer = tpc.layer AND p.provider_key = tpc.provider_key
         WHERE tpc.org_id = $1 AND tpc.layer = $2
         ORDER BY tpc.is_default DESC, tpc.priority ASC
         LIMIT 1
        """,
        org_id,
        layer,
    )


def _decrypt_config_if_needed(config: Any) -> dict[str, Any]:
    import json

    if isinstance(config, str):
        config = json.loads(config)
    if is_encrypted_config(config):
        return decrypt_provider_config(config)
    return config or {}


async def list_providers(conn: asyncpg.Connection, layer: Layer) -> list[asyncpg.Record]:
    """Lists the platform-wide provider catalog for a layer (admin/UI use)."""
    return await conn.fetch(
        "SELECT provider_key, adapter_class_identifier FROM providers "
        "WHERE layer = $1 AND status != 'inactive' ORDER BY default_priority ASC",
        layer,
    )
