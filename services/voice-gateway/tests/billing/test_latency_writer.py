"""Phase 7: proves `write_latency_metric` persists a real
`call_latency_metrics` row (not just a log line), and that the resulting
data is exactly what the scoreboard's aggregation query
(apps/web/lib/billing/scoreboard.ts) expects to consume."""

from __future__ import annotations

import os
import uuid

import asyncpg
import pytest

from voice_gateway.billing.latency_writer import write_latency_metric

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
        f"VG Latency Writer Test Org {suffix}",
        f"vg-latency-writer-org-{suffix}",
    )
    org_id = str(row["id"])
    yield org_id
    await admin_conn.execute("DELETE FROM organizations WHERE id = $1", uuid.UUID(org_id))


@pytest.fixture(autouse=True)
async def _reset_pool(monkeypatch):
    from voice_gateway import db as db_module

    monkeypatch.setenv("DATABASE_URL", APP_URL)
    yield
    await db_module.close_pool()


async def test_write_latency_metric_persists_row(admin_conn, test_org):
    row_id = await write_latency_metric(test_org, None, "stt", "sarvam", "end_of_speech_to_transcript", 0.42)

    row = await admin_conn.fetchrow(
        "SELECT org_id, layer, provider_key, stage, duration_s FROM call_latency_metrics WHERE id = $1",
        uuid.UUID(row_id),
    )
    assert str(row["org_id"]) == test_org
    assert row["layer"] == "stt"
    assert row["provider_key"] == "sarvam"
    assert row["stage"] == "end_of_speech_to_transcript"
    assert float(row["duration_s"]) == pytest.approx(0.42)


async def test_write_latency_metric_allows_null_org_id(admin_conn):
    row_id = await write_latency_metric(None, None, "llm", "gemini_flash_lite", "transcript_to_llm_first_token", 0.31)

    row = await admin_conn.fetchrow(
        "SELECT org_id, layer, provider_key, duration_s FROM call_latency_metrics WHERE id = $1",
        uuid.UUID(row_id),
    )
    assert row["org_id"] is None
    assert row["layer"] == "llm"
    assert float(row["duration_s"]) == pytest.approx(0.31)

    await admin_conn.execute("DELETE FROM call_latency_metrics WHERE id = $1", uuid.UUID(row_id))
