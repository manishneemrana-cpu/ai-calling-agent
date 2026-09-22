"""Durable sink for Phase 3's per-call latency measurements
(`voice_gateway/latency.py`), into the Phase 7 `call_latency_metrics`
table so the Provider Scoreboard (apps/web/lib/billing/scoreboard.ts) can
aggregate real per-provider latency instead of re-inventing measurement.

`voice_gateway/latency.py`'s `TurnLatencyTracker`/`log_stage` today only
emit structured JSON log lines (Phase 3's own stated scope: "measurement +
structured-logging layer Phase 9 will consume"). This module is that
persistence layer. It is intentionally a small, separate, optional sink —
call it from wherever a call's org_id/provider_key are known at the same
point latency.py's tracker finishes a turn (`orchestrator/pipeline.py`),
mirroring how `billing/cost_writer.py` is a separate writer the
orchestrator calls at call end rather than something baked into every
adapter.

HONEST SCOPE NOTE (see the Phase 7 report): wiring a real call site in
`orchestrator/pipeline.py` to call this on every turn is left as a small
follow-up, the same kind of deferred-but-documented item Phase 6 left for
live WhatsApp alert delivery. This module, the `call_latency_metrics`
table, and the scoreboard aggregation query are all in place and tested
against fixture rows (see tests/billing/test_latency_writer.py and
apps/web/tests/billing/scoreboard.test.ts).
"""

from __future__ import annotations

import asyncpg

from ..db import with_tenant


async def write_latency_metric(
    org_id: str | None,
    call_id: str | None,
    layer: str,
    provider_key: str,
    stage: str,
    duration_s: float,
) -> str:
    """Writes one `call_latency_metrics` row. `org_id` may be None (the
    table's RLS policy allows NULL org_id rows, same pattern as
    `telephony_webhook_events`) for a measurement taken before a call is
    fully attributed to a tenant; the scoreboard's aggregation query does
    not require org_id at all, since latency is a platform/provider-level
    concern, not tenant-billed data."""

    async def _write(conn: asyncpg.Connection) -> str:
        row = await conn.fetchrow(
            """
            INSERT INTO call_latency_metrics (org_id, call_id, layer, provider_key, stage, duration_s)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
            """,
            org_id,
            call_id,
            layer,
            provider_key,
            stage,
            duration_s,
        )
        return str(row["id"])

    if org_id is None:
        # No tenant context available yet — use the shared, unscoped
        # connection path (call_latency_metrics' RLS policy permits
        # NULL-org rows regardless of the connecting role's org setting).
        from ..db import get_pool

        pool = await get_pool()
        async with pool.acquire() as conn:
            return await _write(conn)

    return await with_tenant(org_id, None, _write)
