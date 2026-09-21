"""Proves the "call answered" -> pipeline-instantiation trigger path:
`PipelineManager.start_pipeline()` resolves this tenant's configured
stt/tts/llm providers via the SAME registry every other layer uses (no
MockTelephony-specific code path), and `get_orchestrator()` then builds a
working `ConversationOrchestrator` from them — proving the wiring end to end
without any live telephony account (MockTelephony's own webhook payload is
exercised on the apps/web side; see
apps/web/tests/voice-gateway/call-answered-wiring.test.ts for that half)."""

from __future__ import annotations

import json
import os
import uuid

import asyncpg
import pytest

from voice_gateway.media_stream.pipeline_manager import PipelineManager, PipelineNotStartedError

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
        pytest.skip("No reachable Postgres — see root README Quickstart")
    conn = await asyncpg.connect(dsn=ADMIN_URL)
    yield conn
    await conn.close()


@pytest.fixture
async def org_with_mock_providers(admin_conn: asyncpg.Connection):
    suffix = uuid.uuid4().hex[:8]
    row = await admin_conn.fetchrow(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        f"VG Pipeline Manager Test Org {suffix}",
        f"vg-pm-test-org-{suffix}",
    )
    org_id = str(row["id"])
    for layer in ("stt", "tts", "llm"):
        await admin_conn.execute(
            "INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config) "
            "VALUES ($1, $2, 'mock', true, 1, $3)",
            uuid.UUID(org_id),
            layer,
            json.dumps({}),
        )
    yield org_id
    await admin_conn.execute("DELETE FROM organizations WHERE id = $1", uuid.UUID(org_id))


@pytest.fixture(autouse=True)
async def _reset_pool(monkeypatch):
    from voice_gateway import db as db_module

    monkeypatch.setenv("DATABASE_URL", APP_URL)
    yield
    await db_module.close_pool()


async def test_start_pipeline_resolves_tenant_configured_mock_providers_and_builds_orchestrator(
    admin_conn, org_with_mock_providers
):
    org_id = org_with_mock_providers
    manager = PipelineManager()
    call_id = f"call-{uuid.uuid4().hex[:8]}"

    assert not manager.is_started(call_id)
    await manager.start_pipeline(call_id, org_id)
    assert manager.is_started(call_id)

    orchestrator = manager.get_orchestrator(call_id)
    assert orchestrator.call_id == call_id
    assert orchestrator.stt.provider_key == "mock"
    assert orchestrator.llm.provider_key == "mock"
    assert orchestrator.tts.provider_key == "mock"

    manager.end_pipeline(call_id)
    assert not manager.is_started(call_id)


async def test_get_orchestrator_before_start_pipeline_raises():
    manager = PipelineManager()
    with pytest.raises(PipelineNotStartedError):
        manager.get_orchestrator("never-started-call")
