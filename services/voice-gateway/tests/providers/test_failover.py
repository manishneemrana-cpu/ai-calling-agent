"""Phase 9 provider failover proofs (Python/voice-gateway side):

1. Primary configured provider throws -> call_with_failover automatically
   retries against the next-priority configured provider and the "call"
   still succeeds.
2. Every configured provider fails -> a clear AllProvidersFailedError
   surfaces (not a silent hang/crash).
3. Each failover attempt writes a correctly-populated
   `provider_failover_events` row.

Uses real Postgres (same pattern as tests/test_registry.py) with two
test-only adapters registered under the `stt` layer: one that always
raises, one that always succeeds (deterministic mock behavior, no network).
"""

from __future__ import annotations

import os
import uuid

import asyncpg
import pytest

from voice_gateway.adapter_map import _unregister_adapter_for_tests, register_adapter
from voice_gateway.providers.failover import AllProvidersFailedError, call_with_failover

ADMIN_URL = os.environ.get(
    "DATABASE_URL_MIGRATE", "postgresql://postgres:postgres@localhost:5432/ai_calling_agent"
)
APP_URL = os.environ.get(
    "DATABASE_URL", "postgresql://app_user:app_user_dev_password@localhost:5432/ai_calling_agent"
)

pytestmark = pytest.mark.asyncio


class _AlwaysFailsSTT:
    provider_key = "test_failover_primary"

    def __init__(self, config: dict | None = None):
        pass


class _AlwaysWorksSTT:
    provider_key = "test_failover_fallback"

    def __init__(self, config: dict | None = None):
        pass


async def _db_reachable() -> bool:
    try:
        conn = await asyncpg.connect(dsn=ADMIN_URL)
        await conn.close()
        return True
    except Exception:
        return False


@pytest.fixture
async def admin_conn():
    if not await _db_reachable():
        pytest.skip("No reachable Postgres — see root README Quickstart")
    conn = await asyncpg.connect(dsn=ADMIN_URL)
    yield conn
    await conn.close()


@pytest.fixture
async def test_org(admin_conn: asyncpg.Connection):
    suffix = uuid.uuid4().hex[:8]
    row = await admin_conn.fetchrow(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        f"VG Failover Test Org {suffix}",
        f"vg-failover-org-{suffix}",
    )
    org_id = str(row["id"])
    yield org_id
    await admin_conn.execute("DELETE FROM organizations WHERE id = $1", uuid.UUID(org_id))


@pytest.fixture(autouse=True)
async def _setup(admin_conn, monkeypatch):
    from voice_gateway import db as db_module

    monkeypatch.setenv("DATABASE_URL", APP_URL)
    monkeypatch.setenv("PROVIDER_CONFIG_ENCRYPTION_KEY", "test-only-encryption-key-do-not-use-in-prod")

    register_adapter("stt.test_failover_primary", lambda config: _AlwaysFailsSTT(config))
    register_adapter("stt.test_failover_fallback", lambda config: _AlwaysWorksSTT(config))
    await admin_conn.execute(
        """
        INSERT INTO providers (layer, provider_key, display_name, adapter_class_identifier, config_schema, status, default_priority, capabilities)
        VALUES
          ('stt', 'test_failover_primary', 'Test Failover Primary', 'stt.test_failover_primary', '{}'::jsonb, 'active', 999, '{}'::jsonb),
          ('stt', 'test_failover_fallback', 'Test Failover Fallback', 'stt.test_failover_fallback', '{}'::jsonb, 'active', 999, '{}'::jsonb)
        ON CONFLICT (layer, provider_key) DO NOTHING
        """
    )
    yield
    await admin_conn.execute(
        "DELETE FROM providers WHERE provider_key IN ('test_failover_primary', 'test_failover_fallback')"
    )
    _unregister_adapter_for_tests("stt.test_failover_primary")
    _unregister_adapter_for_tests("stt.test_failover_fallback")
    await db_module.close_pool()


async def _configure(admin_conn, org_id: str, provider_key: str, priority: int, is_default: bool = False):
    await admin_conn.execute(
        """
        INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
        VALUES ($1, 'stt', $2, $3, $4, '{}'::jsonb)
        """,
        uuid.UUID(org_id),
        provider_key,
        is_default,
        priority,
    )


async def test_falls_back_to_next_priority_provider_when_primary_throws(admin_conn, test_org):
    await _configure(admin_conn, test_org, "test_failover_primary", priority=1, is_default=True)
    await _configure(admin_conn, test_org, "test_failover_fallback", priority=2)

    async def operation(provider):
        if provider.provider_key == "test_failover_primary":
            raise RuntimeError("simulated primary STT outage")
        return f"transcribed-by-{provider.provider_key}"

    result, used_key = await call_with_failover("stt", test_org, None, operation)

    assert used_key == "test_failover_fallback"
    assert result == "transcribed-by-test_failover_fallback"

    row = await admin_conn.fetchrow(
        "SELECT org_id, layer, from_provider, to_provider, reason FROM provider_failover_events WHERE org_id = $1",
        uuid.UUID(test_org),
    )
    assert row is not None
    assert row["layer"] == "stt"
    assert row["from_provider"] == "test_failover_primary"
    assert row["to_provider"] == "test_failover_fallback"
    assert "simulated primary STT outage" in row["reason"]


async def test_all_providers_failing_raises_a_clear_error_not_a_hang(admin_conn, test_org):
    await _configure(admin_conn, test_org, "test_failover_primary", priority=1, is_default=True)
    await _configure(admin_conn, test_org, "test_failover_fallback", priority=2)

    async def always_fails(provider):
        raise RuntimeError(f"simulated outage for {provider.provider_key}")

    with pytest.raises(AllProvidersFailedError) as exc_info:
        await call_with_failover("stt", test_org, None, always_fails)

    assert len(exc_info.value.attempts) == 2

    events = await admin_conn.fetch(
        "SELECT reason FROM provider_failover_events WHERE org_id = $1 ORDER BY created_at",
        uuid.UUID(test_org),
    )
    assert len(events) == 2  # one mid-chain failover + one terminal exhaustion event
    assert "all_providers_exhausted" in events[-1]["reason"]


async def test_timeout_also_triggers_failover(admin_conn, test_org):
    await _configure(admin_conn, test_org, "test_failover_primary", priority=1, is_default=True)
    await _configure(admin_conn, test_org, "test_failover_fallback", priority=2)

    import asyncio

    async def operation(provider):
        if provider.provider_key == "test_failover_primary":
            await asyncio.sleep(10)  # will be cut short by the timeout, not actually slept
        return "ok"

    result, used_key = await call_with_failover("stt", test_org, None, operation, timeout_s=0.05)
    assert used_key == "test_failover_fallback"
    assert result == "ok"
