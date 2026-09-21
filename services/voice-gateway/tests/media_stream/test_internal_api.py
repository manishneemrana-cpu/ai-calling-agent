"""Proves the "call answered" webhook -> pipeline-instantiation trigger's
Python-side handler works, using MockTelephony-shaped request bodies (no
live telephony account needed) — the sibling half of
apps/web/tests/voice-gateway/call-answered-wiring.test.ts, which proves
apps/web's webhook actually POSTs this shape when a MockTelephony webhook
event fires."""

from __future__ import annotations

import json
import os
import uuid

import asyncpg
import pytest

from voice_gateway.media_stream.internal_api import (
    StartPipelineRequestError,
    handle_start_pipeline_request,
)
from voice_gateway.media_stream.pipeline_manager import PipelineManager

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
        f"VG Internal API Test Org {suffix}",
        f"vg-internal-api-test-org-{suffix}",
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


async def test_call_answered_trigger_starts_a_pipeline_for_mock_telephony(
    admin_conn, org_with_mock_providers
):
    org_id = org_with_mock_providers
    manager = PipelineManager()
    call_id = f"call-{uuid.uuid4().hex[:8]}"

    # Shape MockTelephony's webhook->apps/web->voice-gateway trigger actually
    # sends (see apps/web/lib/voice-gateway/client.ts).
    result = await handle_start_pipeline_request(
        {"orgId": org_id, "callId": call_id, "userId": None, "providerKey": "mock"}, manager
    )

    assert result == {"started": True, "callId": call_id}
    assert manager.is_started(call_id)


async def test_missing_org_id_is_rejected_without_touching_the_pipeline_manager():
    manager = PipelineManager()
    with pytest.raises(StartPipelineRequestError):
        await handle_start_pipeline_request({"callId": "call-x"}, manager)
    assert not manager.is_started("call-x")
