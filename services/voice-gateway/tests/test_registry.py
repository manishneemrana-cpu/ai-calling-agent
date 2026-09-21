"""Provider Registry factory tests — Python side of the same "no core
rewrite to add a provider" proof apps/web/tests/providers/registry.test.ts
gives for telephony, now for the `stt` layer.

Uses a real Postgres connection (same DB apps/web's tests use): seed as the
migration/admin role via asyncpg, exercise via `registry.get_provider` as
app_user with app.current_org_id set, exactly like production request
handling. Requires DATABASE_URL_MIGRATE / DATABASE_URL_ADMIN pointed at a
reachable Postgres with migrations 001-008 already applied (see root
README's Quickstart) — skipped automatically if no DB is reachable, the
same accommodation apps/web's own DB-backed tests make for CI environments
without a live Postgres.
"""

from __future__ import annotations

import os
import uuid

import asyncpg
import pytest

from voice_gateway.adapter_map import _unregister_adapter_for_tests, register_adapter
from voice_gateway.crypto import encrypt_provider_config
from voice_gateway.registry import ProviderNotConfiguredError, get_provider
from voice_gateway.stt.adapters.mock import MockSTTProvider
from voice_gateway.stt.adapters.sarvam import SarvamSTTProvider

ADMIN_URL = os.environ.get(
    "DATABASE_URL_MIGRATE", "postgresql://postgres:postgres@localhost:5432/ai_calling_agent"
)
APP_URL = os.environ.get(
    "DATABASE_URL", "postgresql://app_user:app_user_dev_password@localhost:5432/ai_calling_agent"
)


async def _db_reachable() -> bool:
    try:
        conn = await asyncpg.connect(dsn=ADMIN_URL)
        await conn.close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.asyncio


@pytest.fixture
async def admin_conn():
    if not await _db_reachable():
        pytest.skip("No reachable Postgres for registry integration tests — see root README Quickstart")
    conn = await asyncpg.connect(dsn=ADMIN_URL)
    yield conn
    await conn.close()


@pytest.fixture
async def org_id(admin_conn: asyncpg.Connection):
    suffix = uuid.uuid4().hex[:8]
    row = await admin_conn.fetchrow(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        f"Voice Gateway Registry Test Org {suffix}",
        f"vg-registry-test-org-{suffix}",
    )
    org_id = str(row["id"])
    yield org_id
    await admin_conn.execute("DELETE FROM organizations WHERE id = $1", uuid.UUID(org_id))


async def _set_default_provider(
    admin_conn, org_id: str, layer: str, provider_key: str, config: dict | None = None
):
    import json

    await admin_conn.execute(
        """
        INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
        VALUES ($1, $2, $3, true, 1, $4)
        """,
        uuid.UUID(org_id),
        layer,
        provider_key,
        json.dumps(config or {}),
    )


async def _clear_provider_config(admin_conn, org_id: str):
    await admin_conn.execute("DELETE FROM tenant_provider_config WHERE org_id = $1", uuid.UUID(org_id))


@pytest.fixture(autouse=True)
async def _set_encryption_key_and_reset_pool(monkeypatch):
    from voice_gateway import db as db_module

    monkeypatch.setenv("DATABASE_URL", APP_URL)
    monkeypatch.setenv("PROVIDER_CONFIG_ENCRYPTION_KEY", "test-only-encryption-key-do-not-use-in-prod")
    yield
    # Each test function runs in its own event loop under pytest-asyncio's
    # default (function-scoped) loop; asyncpg pools are bound to the loop
    # they were created in, so the module-level pool cache in db.py must be
    # torn down between tests rather than reused across loops.
    await db_module.close_pool()


async def test_resolves_mock_stt_adapter(admin_conn, org_id):
    await _clear_provider_config(admin_conn, org_id)
    await _set_default_provider(admin_conn, org_id, "stt", "mock")
    provider = await get_provider("stt", org_id, None)
    assert isinstance(provider, MockSTTProvider)
    assert provider.provider_key == "mock"


async def test_resolves_sarvam_stt_adapter(admin_conn, org_id):
    await _clear_provider_config(admin_conn, org_id)
    await _set_default_provider(admin_conn, org_id, "stt", "sarvam", {"api_key": "fake_api_key"})
    provider = await get_provider("stt", org_id, None)
    assert isinstance(provider, SarvamSTTProvider)
    assert provider.provider_key == "sarvam"


async def test_decrypts_encrypted_config_envelope(admin_conn, org_id):
    import json

    await _clear_provider_config(admin_conn, org_id)
    encrypted = encrypt_provider_config({"api_key": "secret-key"})
    await admin_conn.execute(
        """
        INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
        VALUES ($1, 'stt', 'sarvam', true, 1, $2)
        """,
        uuid.UUID(org_id),
        json.dumps(encrypted),
    )
    provider = await get_provider("stt", org_id, None)
    assert isinstance(provider, SarvamSTTProvider)


async def test_raises_when_no_provider_configured(admin_conn, org_id):
    await _clear_provider_config(admin_conn, org_id)
    with pytest.raises(ProviderNotConfiguredError):
        await get_provider("stt", org_id, None)


async def test_new_provider_resolvable_with_zero_changes_to_registry_or_existing_adapters(admin_conn, org_id):
    """PROOF: a brand-new provider (new adapter class + a new `providers`
    row) is resolvable by the SAME, completely unmodified factory function —
    mirrors apps/web/tests/providers/registry.test.ts's telephony proof, now
    for the stt layer."""

    class FakeTestOnlySTTProvider:
        provider_key = "fake_test_only_vendor"

        def __init__(self, config: dict):
            self.config = config

    register_adapter("stt.fake_test_only_vendor", lambda config: FakeTestOnlySTTProvider(config))
    try:
        await admin_conn.execute(
            """
            INSERT INTO providers (layer, provider_key, display_name, adapter_class_identifier, config_schema, status, default_priority, capabilities)
            VALUES ('stt', 'fake_test_only_vendor', 'Fake Test-Only Vendor', 'stt.fake_test_only_vendor', '{}'::jsonb, 'active', 999, '{}'::jsonb)
            ON CONFLICT (layer, provider_key) DO NOTHING
            """
        )
        await _clear_provider_config(admin_conn, org_id)
        await _set_default_provider(admin_conn, org_id, "stt", "fake_test_only_vendor")

        provider = await get_provider("stt", org_id, None)
        assert isinstance(provider, FakeTestOnlySTTProvider)
        assert provider.provider_key == "fake_test_only_vendor"
    finally:
        await _clear_provider_config(admin_conn, org_id)
        await admin_conn.execute("DELETE FROM providers WHERE provider_key = 'fake_test_only_vendor'")
        _unregister_adapter_for_tests("stt.fake_test_only_vendor")
