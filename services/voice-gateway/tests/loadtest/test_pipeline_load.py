"""Phase 9 load test (mock-adapter path, voice-gateway side) — see
docs/LOAD_TESTING.md for the full write-up.

Runs N concurrent `ConversationOrchestrator.run_turn()` calls (the real
orchestrator class every live call uses — see orchestrator/pipeline.py),
each against its own MockSTT/MockLLM/MockTTS instances (mock providers are
NOT shared/stateful across calls, mirroring N independent real calls), and
reports real throughput/latency numbers. Also writes real
`call_latency_metrics` rows per turn (Phase 9's newly-wired latency
recording — see tests/billing/test_pipeline_latency_wiring.py) across
several distinct tenant orgs at once, proving that write path is
concurrency-safe too (no cross-tenant leakage, no crash under concurrent
inserts).
"""

from __future__ import annotations

import asyncio
import os
import time
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
CONCURRENCY = int(os.environ.get("LOADTEST_CONCURRENCY", "100"))
ORG_COUNT = 5

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
async def org_ids(admin_conn: asyncpg.Connection):
    ids = []
    for _ in range(ORG_COUNT):
        suffix = uuid.uuid4().hex[:8]
        row = await admin_conn.fetchrow(
            "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
            f"VG Load Test Org {suffix}",
            f"vg-loadtest-org-{suffix}",
        )
        ids.append(str(row["id"]))
    yield ids
    for org_id in ids:
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


async def _run_one_turn(org_id: str) -> float:
    orchestrator = ConversationOrchestrator(
        call_id=None,
        stt=MockSTTProvider(),
        llm=MockLLMProvider(),
        tts=MockTTSProvider(),
        org_id=org_id,
        stt_provider_key="mock",
        llm_provider_key="mock",
        tts_provider_key="mock",
    )
    t0 = time.perf_counter()
    async for _chunk in orchestrator.run_turn(_audio_chunks(9)):
        pass
    return time.perf_counter() - t0


async def test_concurrent_mock_pipeline_turns_and_latency_writes(admin_conn, org_ids):
    started = time.perf_counter()
    results = await asyncio.gather(
        *[_run_one_turn(org_ids[i % ORG_COUNT]) for i in range(CONCURRENCY)],
        return_exceptions=True,
    )
    wall_clock_s = time.perf_counter() - started

    latencies = sorted(r for r in results if isinstance(r, float))
    errors = [r for r in results if isinstance(r, Exception)]
    p50 = latencies[int(len(latencies) * 0.5)]
    p95 = latencies[int(len(latencies) * 0.95)]
    throughput = CONCURRENCY / wall_clock_s

    print(
        f"[LOAD TEST] concurrency={CONCURRENCY} wall_clock_s={wall_clock_s:.3f} "
        f"throughput_turns_per_s={throughput:.1f} p50_ms={p50 * 1000:.1f} "
        f"p95_ms={p95 * 1000:.1f} errors={len(errors)}/{CONCURRENCY}"
    )

    assert len(errors) == 0

    # Tenant isolation under concurrent latency writes: each org's row
    # count matches exactly what was routed to it (3 stages per turn).
    for i, org_id in enumerate(org_ids):
        expected_turns = len([j for j in range(CONCURRENCY) if j % ORG_COUNT == i])
        row = await admin_conn.fetchrow(
            "SELECT count(*)::int AS c FROM call_latency_metrics WHERE org_id = $1", uuid.UUID(org_id)
        )
        assert row["c"] == expected_turns * 3
