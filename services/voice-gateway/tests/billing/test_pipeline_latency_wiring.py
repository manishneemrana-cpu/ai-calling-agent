"""Phase 9: proves the ACTUAL pipeline call site (orchestrator/pipeline.py's
run_turn) now writes real `call_latency_metrics` rows for a real (mock-
provider) call turn — closing the gap Phase 7 explicitly deferred (the
writer, table and scoreboard query existed; nothing called the writer from
a live turn). Uses real Postgres, same pattern as
tests/billing/test_latency_writer.py."""

from __future__ import annotations

import os
import uuid

import asyncpg
import pytest

from voice_gateway.llm.adapters.mock import MockLLMProvider
from voice_gateway.orchestrator.pipeline import ConversationOrchestrator
from voice_gateway.stt.adapters.mock import MockSTTProvider
from voice_gateway.tts.adapters.mock import MockTTSProvider

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
async def test_org(admin_conn: asyncpg.Connection):
    suffix = uuid.uuid4().hex[:8]
    row = await admin_conn.fetchrow(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        f"VG Pipeline Latency Wiring Test Org {suffix}",
        f"vg-pipeline-latency-org-{suffix}",
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


async def _audio_chunks(n: int):
    for _ in range(n):
        yield b"\x00" * 160


async def test_a_real_mock_call_turn_writes_real_latency_rows(admin_conn, test_org):
    orchestrator = ConversationOrchestrator(
        call_id=None,  # no real `calls` row needed for this proof — the writer/table allow a NULL call_id
        stt=MockSTTProvider(),
        llm=MockLLMProvider(),
        tts=MockTTSProvider(),
        org_id=test_org,
        stt_provider_key="mock",
        llm_provider_key="mock",
        tts_provider_key="mock",
    )

    audio_out = [chunk async for chunk in orchestrator.run_turn(_audio_chunks(9))]
    assert len(audio_out) > 0  # sanity: the turn actually produced a reply

    rows = await admin_conn.fetch(
        "SELECT layer, provider_key, stage, duration_s FROM call_latency_metrics WHERE org_id = $1 ORDER BY stage",
        uuid.UUID(test_org),
    )
    stages_written = {r["stage"] for r in rows}
    assert stages_written == {
        "end_of_speech_to_transcript",
        "transcript_to_llm_first_token",
        "llm_first_token_to_first_tts_byte",
    }
    by_stage = {r["stage"]: r for r in rows}
    assert by_stage["end_of_speech_to_transcript"]["layer"] == "stt"
    assert by_stage["end_of_speech_to_transcript"]["provider_key"] == "mock"
    assert by_stage["transcript_to_llm_first_token"]["layer"] == "llm"
    assert by_stage["llm_first_token_to_first_tts_byte"]["layer"] == "tts"
    for r in rows:
        assert float(r["duration_s"]) >= 0

    await admin_conn.execute("DELETE FROM call_latency_metrics WHERE org_id = $1", uuid.UUID(test_org))
