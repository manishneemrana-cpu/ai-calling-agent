"""Tenant-isolation proof, Python side, for the STT/TTS/LLM
`tenant_provider_config` rows this phase adds.

No new tables were introduced (Phase 3 only added rows via
db/migrations/008_stt_tts_llm_providers.sql to the existing
`providers`/`tenant_provider_config` tables from Phase 2's
007_provider_registry.sql, whose RLS policies apps/web's
tenant-isolation.test.ts already proves for the telephony layer). This test
re-proves the same Postgres RLS boundary independently for the stt layer
from THIS runtime (voice_gateway.db.with_tenant), since it is a second,
separate process connecting to the same database and must not rely on
apps/web's test suite alone to catch a regression on its own connection
path (a different `SET LOCAL` bug in db.py wouldn't be caught by the TS
tests at all).

Skipped automatically if no reachable Postgres — same accommodation as
tests/test_registry.py.
"""

from __future__ import annotations

import json
import os
import uuid

import asyncpg
import pytest

from voice_gateway.db import with_tenant

ADMIN_URL = os.environ.get(
    "DATABASE_URL_MIGRATE", "postgresql://postgres:postgres@localhost:5432/ai_calling_agent"
)
APP_URL = os.environ.get(
    "DATABASE_URL", "postgresql://app_user:app_user_dev_password@localhost:5432/ai_calling_agent"
)

pytestmark = pytest.mark.asyncio


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
        pytest.skip(
            "No reachable Postgres for tenant-isolation integration tests — see root README Quickstart"
        )
    conn = await asyncpg.connect(dsn=ADMIN_URL)
    yield conn
    await conn.close()


@pytest.fixture
async def two_orgs(admin_conn: asyncpg.Connection):
    suffix = uuid.uuid4().hex[:8]
    row_a = await admin_conn.fetchrow(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        f"VG Isolation Test Org A {suffix}",
        f"vg-iso-test-org-a-{suffix}",
    )
    row_b = await admin_conn.fetchrow(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        f"VG Isolation Test Org B {suffix}",
        f"vg-iso-test-org-b-{suffix}",
    )
    org_a, org_b = str(row_a["id"]), str(row_b["id"])
    await admin_conn.execute(
        "INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config) "
        "VALUES ($1, 'stt', 'sarvam', true, 1, $2)",
        uuid.UUID(org_a),
        json.dumps({"api_key": "org-a-secret"}),
    )
    await admin_conn.execute(
        "INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config) "
        "VALUES ($1, 'stt', 'deepgram', true, 1, $2)",
        uuid.UUID(org_b),
        json.dumps({"api_key": "org-b-secret"}),
    )
    yield org_a, org_b
    await admin_conn.execute(
        "DELETE FROM organizations WHERE id = ANY($1)", [uuid.UUID(org_a), uuid.UUID(org_b)]
    )


@pytest.fixture(autouse=True)
async def _reset_pool(monkeypatch):
    from voice_gateway import db as db_module

    monkeypatch.setenv("DATABASE_URL", APP_URL)
    yield
    await db_module.close_pool()


async def test_org_cannot_see_another_orgs_stt_config_row(admin_conn, two_orgs):
    org_a, org_b = two_orgs

    async def read_stt_rows(conn: asyncpg.Connection) -> list[str]:
        rows = await conn.fetch("SELECT provider_key FROM tenant_provider_config WHERE layer = 'stt'")
        return [r["provider_key"] for r in rows]

    rows_as_a = await with_tenant(org_a, None, read_stt_rows)
    assert rows_as_a == ["sarvam"]  # never sees org B's 'deepgram' row

    rows_as_b = await with_tenant(org_b, None, read_stt_rows)
    assert rows_as_b == ["deepgram"]  # never sees org A's 'sarvam' row


async def test_org_cannot_write_a_config_row_for_another_org(admin_conn, two_orgs):
    org_a, org_b = two_orgs

    async def try_insert_for_org_b(conn: asyncpg.Connection):
        # FORCE ROW LEVEL SECURITY means even an INSERT whose org_id column
        # doesn't match the session's current_org_id is rejected by the
        # WITH CHECK clause, not silently redirected — this must raise.
        await conn.execute(
            "INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config) "
            "VALUES ($1, 'tts', 'mock', false, 5, '{}'::jsonb)",
            uuid.UUID(org_b),
        )

    with pytest.raises(asyncpg.PostgresError):
        await with_tenant(org_a, None, try_insert_for_org_b)
