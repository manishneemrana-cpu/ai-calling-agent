"""Postgres access for the voice-gateway service.

Connects to the SAME database apps/web uses (DATABASE_URL, shared across
both runtimes — see docs/PROVIDER_REGISTRY.md and the root README's
"two-runtime, one Postgres" note). Mirrors apps/web/lib/db/tenant.ts's
`withTenant`: every tenant-scoped query goes through `with_tenant`, which
sets `app.current_org_id` as a transaction-local (`SET LOCAL`) setting so
the same RLS policies apps/web relies on are enforced identically from this
runtime — the database is the tenant-isolation boundary, not either
application's code.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from typing import TypeVar

import asyncpg

T = TypeVar("T")

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        dsn = os.environ.get("DATABASE_URL")
        if not dsn:
            raise RuntimeError("DATABASE_URL is not set. See .env.example.")
        _pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=10)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def with_tenant(
    org_id: str,
    user_id: str | None,
    fn: Callable[[asyncpg.Connection], Awaitable[T]],
) -> T:
    pool = await get_pool()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT set_config('app.current_org_id', $1, true)", org_id)
        await conn.execute("SELECT set_config('app.current_user_id', $1, true)", user_id or "")
        # Phase 8 (apps/web/lib/db/tenant.ts's withTenant, mirrored here):
        # app.current_org_role gates platform-only data (e.g.
        # provider_rate_cards — see
        # db/migrations/013_phase8_reseller_hierarchy.sql). Re-derived from
        # the organizations row itself every transaction, never trusted from
        # a caller-supplied argument, so it can never drift from the org's
        # actual role in the DB.
        org_role = await conn.fetchval(
            "SELECT org_role FROM organizations WHERE id = current_org_id()"
        )
        await conn.execute("SELECT set_config('app.current_org_role', $1, true)", org_role or "")
        return await fn(conn)
