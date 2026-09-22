"""Human handoff: the `transferToHuman` tool, wired into the orchestrator's
existing generic tool-dispatch path from Phase 3
(`voice_gateway.orchestrator.pipeline.ConversationOrchestrator` — unchanged
by this phase, since it already accepts any `tools`/`tool_dispatcher` a
caller wires up).

Live notification delivery to a human salesperson (SMS/WhatsApp/app
push/call transfer) is explicitly OUT of scope this phase — see
docs/CRM_LOGIC.md "Deferred to Phase 6+". The testable deliverable here is
that a `transferToHuman` tool call reliably produces one correctly
populated `handoff_requests` row.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import asyncpg

from ..db import with_tenant
from ..llm.types import ToolCall, ToolDefinition

TRANSFER_TO_HUMAN_TOOL = ToolDefinition(
    name="transferToHuman",
    description=(
        "Call this when the caller explicitly asks to speak to a person, "
        "when a real (human) salesperson should take over the conversation, "
        "or when the caller asks for a callback from a human instead of "
        "continuing with the AI agent."
    ),
    parameters={
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "enum": ["explicit_request", "high_score", "objection_escalation", "other"],
                "description": "Why this handoff is being requested.",
            },
            "transfer_type": {
                "type": "string",
                "enum": ["warm", "cold", "callback_request"],
                "description": (
                    "warm = live transfer with context; cold = blind transfer; "
                    "callback_request = schedule a human callback."
                ),
            },
        },
        "required": ["reason", "transfer_type"],
    },
)


@dataclass(frozen=True)
class HandoffSnapshot:
    """The payload snapshot handed to the human salesperson, per the master
    spec's exact list: name, requirement, budget, location, conversation
    summary, lead score, product/property discussed, objections."""

    full_name: str | None = None
    requirement: str | None = None
    budget: str | None = None
    location: str | None = None
    summary: str | None = None
    lead_score: int | None = None
    product_type: str | None = None
    objections: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class WrittenHandoffRequest:
    handoff_request_id: str


def _valid_reason(value: str) -> str:
    return value if value in ("explicit_request", "high_score", "objection_escalation", "other") else "other"


def _valid_transfer_type(value: str) -> str:
    return value if value in ("warm", "cold", "callback_request") else "cold"


async def create_handoff_request(
    org_id: str,
    call_id: str | None,
    lead_id: str | None,
    reason: str,
    transfer_type: str,
    snapshot: HandoffSnapshot,
    *,
    assigned_salesperson_user_id: str | None = None,
    user_id: str | None = None,
) -> WrittenHandoffRequest:
    payload = {
        "full_name": snapshot.full_name,
        "requirement": snapshot.requirement,
        "budget": snapshot.budget,
        "location": snapshot.location,
        "summary": snapshot.summary,
        "lead_score": snapshot.lead_score,
        "product_type": snapshot.product_type,
        "objections": snapshot.objections,
    }

    async def _write(conn: asyncpg.Connection) -> WrittenHandoffRequest:
        row = await conn.fetchrow(
            """
            INSERT INTO handoff_requests
                (org_id, call_id, lead_id, trigger_reason, transfer_type,
                 assigned_salesperson_user_id, status, handoff_payload)
            VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::jsonb)
            RETURNING id
            """,
            org_id,
            call_id,
            lead_id,
            _valid_reason(reason),
            _valid_transfer_type(transfer_type),
            assigned_salesperson_user_id,
            json.dumps(payload),
        )
        return WrittenHandoffRequest(handoff_request_id=str(row["id"]))

    return await with_tenant(org_id, user_id, _write)


def make_transfer_to_human_dispatcher(
    *,
    org_id: str,
    call_id: str | None,
    lead_id: str | None,
    snapshot_provider,
):
    """Builds a tool-dispatcher callback matching
    `voice_gateway.orchestrator.pipeline.ToolDispatcher` (`ToolCall ->
    str`), for `transferToHuman` specifically. `snapshot_provider` is a
    zero-arg (sync or async) callable returning the current
    `HandoffSnapshot` for this call — kept as an injected callable so this
    module never has to know how a caller assembles a snapshot (from a
    live call_summaries row, from in-call state, or a test fixture)."""

    async def dispatcher(tool_call: ToolCall) -> str:
        if tool_call.name != TRANSFER_TO_HUMAN_TOOL.name:
            return f"(transfer_to_human dispatcher cannot handle tool '{tool_call.name}')"

        snapshot = snapshot_provider()
        if hasattr(snapshot, "__await__"):
            snapshot = await snapshot

        reason = str(tool_call.arguments.get("reason", "other"))
        transfer_type = str(tool_call.arguments.get("transfer_type", "cold"))

        result = await create_handoff_request(
            org_id=org_id,
            call_id=call_id,
            lead_id=lead_id,
            reason=reason,
            transfer_type=transfer_type,
            snapshot=snapshot,
        )
        return f"handoff_requested:{result.handoff_request_id}"

    return dispatcher
