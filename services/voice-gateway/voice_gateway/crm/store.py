"""The DB writer paths for Phase 5 CRM records, mirroring
voice_gateway/billing/cost_writer.py's "one writer module, callers pass in
already-computed values" pattern. Every write goes through
`voice_gateway.db.with_tenant`, so the same RLS boundary apps/web relies on
is enforced identically from this runtime.
"""

from __future__ import annotations

from dataclasses import dataclass

import asyncpg

from ..db import with_tenant
from .summary import ParsedCallSummary


@dataclass(frozen=True)
class WrittenCallSummary:
    call_summary_id: str


async def write_call_summary(
    org_id: str,
    call_id: str,
    lead_id: str | None,
    summary: ParsedCallSummary,
    *,
    user_id: str | None = None,
) -> WrittenCallSummary:
    """Writes one `call_summaries` row and, if `lead_id` is given, updates
    `leads.latest_call_summary_id` (+ `score`/`score_band`, if the caller
    already computed those via voice_gateway.crm.scoring — passed
    separately, see write_call_summary_and_score) — all in one
    tenant-scoped transaction."""

    async def _write(conn: asyncpg.Connection) -> WrittenCallSummary:
        row = await conn.fetchrow(
            """
            INSERT INTO call_summaries
                (org_id, call_id, lead_id, requirement_text, budget_value, location,
                 product_type, intent, objections, next_action, follow_up_date,
                 lead_score_at_call, recommended_action, needs_review, raw_llm_output)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::date, $12, $13, $14, $15::jsonb)
            ON CONFLICT (call_id) DO UPDATE SET
                requirement_text = EXCLUDED.requirement_text,
                budget_value = EXCLUDED.budget_value,
                location = EXCLUDED.location,
                product_type = EXCLUDED.product_type,
                intent = EXCLUDED.intent,
                objections = EXCLUDED.objections,
                next_action = EXCLUDED.next_action,
                follow_up_date = EXCLUDED.follow_up_date,
                lead_score_at_call = EXCLUDED.lead_score_at_call,
                recommended_action = EXCLUDED.recommended_action,
                needs_review = EXCLUDED.needs_review,
                raw_llm_output = EXCLUDED.raw_llm_output
            RETURNING id
            """,
            org_id,
            call_id,
            lead_id,
            summary.requirement,
            summary.budget,
            summary.location,
            summary.product_type,
            summary.intent,
            _to_jsonb(summary.objections),
            summary.next_action,
            summary.follow_up_date,
            summary.lead_score,
            summary.recommended_action,
            summary.needs_review,
            _to_jsonb_or_null(summary.raw_llm_output),
        )

        if lead_id is not None:
            await conn.execute(
                "UPDATE leads SET latest_call_summary_id = $1, updated_at = now() "
                "WHERE id = $2 AND org_id = $3",
                row["id"],
                lead_id,
                org_id,
            )

        return WrittenCallSummary(call_summary_id=str(row["id"]))

    return await with_tenant(org_id, user_id, _write)


async def update_lead_score(
    org_id: str,
    lead_id: str,
    score: int,
    band: str,
    *,
    user_id: str | None = None,
) -> None:
    async def _write(conn: asyncpg.Connection) -> None:
        await conn.execute(
            "UPDATE leads SET score = $1, score_band = $2, updated_at = now() WHERE id = $3 AND org_id = $4",
            score,
            band,
            lead_id,
            org_id,
        )

    await with_tenant(org_id, user_id, _write)


def _to_jsonb(value: list[str]) -> str:
    import json

    return json.dumps(value)


def _to_jsonb_or_null(value: str | None) -> str | None:
    import json

    if value is None:
        return None
    return json.dumps({"raw": value})
