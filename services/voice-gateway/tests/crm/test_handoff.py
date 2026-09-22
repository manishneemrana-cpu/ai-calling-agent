"""Proves the `transferToHuman` tool call, dispatched through the exact
same `ConversationOrchestrator` tool-dispatch path Phase 3 built (no
orchestrator code changed), creates a correctly-populated
`handoff_requests` row — the task's own MockLLM-with-tool-call test
pattern (see tests/test_pipeline_e2e.py) reused here for a CRM tool
instead of `lookup_order_status`.

DB-backed; skipped automatically if no reachable Postgres, same
accommodation as tests/test_tenant_isolation.py and tests/test_registry.py.
"""

from __future__ import annotations

import uuid

import asyncpg
import pytest

from voice_gateway.crm.handoff import (
    TRANSFER_TO_HUMAN_TOOL,
    HandoffSnapshot,
    make_transfer_to_human_dispatcher,
)
from voice_gateway.db import with_tenant
from voice_gateway.llm.adapters.mock import MockLLMProvider
from voice_gateway.llm.types import ToolCall
from voice_gateway.orchestrator.pipeline import ConversationOrchestrator
from voice_gateway.stt.adapters.mock import MockSTTProvider
from voice_gateway.tts.adapters.mock import MockTTSProvider

ADMIN_URL = "postgresql://postgres:postgres@localhost:5432/ai_calling_agent"
APP_URL = "postgresql://app_user:app_user_dev_password@localhost:5432/ai_calling_agent"

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
        pytest.skip("No reachable Postgres for handoff integration tests — see root README Quickstart")
    conn = await asyncpg.connect(dsn=ADMIN_URL)
    yield conn
    await conn.close()


@pytest.fixture
async def org_and_lead(admin_conn: asyncpg.Connection):
    suffix = uuid.uuid4().hex[:8]
    org_row = await admin_conn.fetchrow(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        f"VG Handoff Test Org {suffix}",
        f"vg-handoff-test-org-{suffix}",
    )
    org_id = str(org_row["id"])
    lead_row = await admin_conn.fetchrow(
        "INSERT INTO leads (org_id, full_name, phone_number) VALUES ($1, $2, $3) RETURNING id",
        uuid.UUID(org_id),
        "Test Caller",
        "+919999900000",
    )
    lead_id = str(lead_row["id"])
    yield org_id, lead_id
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


async def test_transfer_to_human_tool_call_creates_handoff_request_row(admin_conn, org_and_lead):
    org_id, lead_id = org_and_lead

    dispatcher = make_transfer_to_human_dispatcher(
        org_id=org_id,
        call_id=None,
        lead_id=lead_id,
        snapshot_provider=lambda: HandoffSnapshot(
            full_name="Test Caller",
            requirement="2BHK flat",
            budget="50-60 lakh",
            location="Patna",
            summary="Caller is highly interested, wants a call from a human agent.",
            lead_score=85,
            product_type="2BHK flat",
            objections=["price too high"],
        ),
    )

    orchestrator = ConversationOrchestrator(
        call_id="handoff-test-1",
        stt=MockSTTProvider(),
        llm=MockLLMProvider(config={"canned_tool_name": "transferToHuman"}),
        tts=MockTTSProvider(),
        tool_dispatcher=dispatcher,
        tools=[TRANSFER_TO_HUMAN_TOOL],
    )

    # Drive the tool-call path directly (mirrors test_pipeline_e2e.py):
    # MockLLM's canned first-call tool invocation doesn't carry our
    # specific arguments, so dispatch a realistic ToolCall explicitly to
    # prove the orchestrator's dispatch plumbing + our handler together.
    result_text = await orchestrator._dispatch_tool(
        ToolCall(
            id="call-1",
            name="transferToHuman",
            arguments={"reason": "explicit_request", "transfer_type": "warm"},
        )
    )
    assert result_text.startswith("handoff_requested:")
    handoff_id = result_text.split(":", 1)[1]

    async def read_row(conn: asyncpg.Connection):
        return await conn.fetchrow("SELECT * FROM handoff_requests WHERE id = $1", uuid.UUID(handoff_id))

    row = await with_tenant(org_id, None, read_row)
    assert row is not None
    assert row["trigger_reason"] == "explicit_request"
    assert row["transfer_type"] == "warm"
    assert row["status"] == "pending"
    assert row["lead_id"] == uuid.UUID(lead_id)

    import json

    payload = json.loads(row["handoff_payload"]) if isinstance(row["handoff_payload"], str) else row["handoff_payload"]
    assert payload["full_name"] == "Test Caller"
    assert payload["requirement"] == "2BHK flat"
    assert payload["budget"] == "50-60 lakh"
    assert payload["location"] == "Patna"
    assert payload["lead_score"] == 85
    assert payload["product_type"] == "2BHK flat"
    assert payload["objections"] == ["price too high"]


async def test_full_orchestrator_turn_dispatches_transfer_to_human_via_llm_tool_call(admin_conn, org_and_lead):
    """End-to-end: MockLLM emits a tool_call event for `transferToHuman`
    during a normal `run_turn`, and the orchestrator's own dispatch path
    (not a direct `_dispatch_tool` call) creates the row."""
    org_id, lead_id = org_and_lead

    dispatcher = make_transfer_to_human_dispatcher(
        org_id=org_id,
        call_id=None,
        lead_id=lead_id,
        snapshot_provider=lambda: HandoffSnapshot(full_name="Test Caller", lead_score=90),
    )

    class TransferMockLLM(MockLLMProvider):
        async def stream_chat(self, messages, tools=None):
            from voice_gateway.llm.types import LLMStreamEvent
            from voice_gateway.usage import UsageReport

            has_tool_result = any(m.role == "tool" for m in messages)
            if not has_tool_result:
                yield LLMStreamEvent(
                    type="tool_call",
                    tool_call=ToolCall(
                        id="c1",
                        name="transferToHuman",
                        arguments={"reason": "high_score", "transfer_type": "callback_request"},
                    ),
                )
                yield LLMStreamEvent(
                    type="done", usage=UsageReport(provider_key="mock", layer="llm", unit="tokens", quantity=1)
                )
                return
            yield LLMStreamEvent(type="text_delta", text_delta="Sure, someone will call you back.")
            yield LLMStreamEvent(
                type="done", usage=UsageReport(provider_key="mock", layer="llm", unit="tokens", quantity=1)
            )

    orchestrator = ConversationOrchestrator(
        call_id="handoff-test-2",
        stt=MockSTTProvider(),
        llm=TransferMockLLM(),
        tts=MockTTSProvider(),
        tool_dispatcher=dispatcher,
        tools=[TRANSFER_TO_HUMAN_TOOL],
    )

    audio_out = [chunk async for chunk in orchestrator.run_turn(_audio_chunks(9))]
    assert len(audio_out) > 0
    assert any(m.role == "tool" and m.content.startswith("handoff_requested:") for m in orchestrator.messages)

    async def count_rows(conn: asyncpg.Connection):
        return await conn.fetchval(
            "SELECT count(*) FROM handoff_requests WHERE lead_id = $1 AND transfer_type = 'callback_request'",
            uuid.UUID(lead_id),
        )

    count = await with_tenant(org_id, None, count_rows)
    assert count == 1
