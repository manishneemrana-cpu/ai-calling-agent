"""Durable sink for Phase 9 provider-failover events, into
`provider_failover_events` (db/migrations/014_phase9_observability_failover.sql)
— mirrors `billing/latency_writer.py`'s pattern exactly (a small, separate,
optional writer the failover logic calls at the moment it decides to retry
against the next-priority provider)."""

from __future__ import annotations

import asyncpg

from ..db import get_pool, with_tenant


async def write_failover_event(
    org_id: str | None,
    layer: str,
    from_provider: str,
    to_provider: str,
    reason: str,
    call_id: str | None = None,
) -> str:
    async def _write(conn: asyncpg.Connection) -> str:
        row = await conn.fetchrow(
            """
            INSERT INTO provider_failover_events (org_id, layer, from_provider, to_provider, reason, call_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
            """,
            org_id,
            layer,
            from_provider,
            to_provider,
            reason,
            call_id,
        )
        return str(row["id"])

    if org_id is None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            return await _write(conn)

    return await with_tenant(org_id, None, _write)
