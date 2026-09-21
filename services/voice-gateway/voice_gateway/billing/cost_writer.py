"""The single writer path from a call's collected `UsageReport`s
(voice_gateway/usage.py) into the existing `usage_records` / `cost_records`
tables (db/migrations/004_billing_providers.sql — unchanged schema).

Per the Phase 3 README's "Deferred / follow-up work": every adapter already
RETURNS a `UsageReport` per call, but nothing INSERTed it. This module is
that one writer — the orchestrator (or, for now, whatever call-lifecycle
code holds a call's org_id/call_id, e.g. `PipelineManager`/`server.py`)
calls `write_call_usage()` once, typically at call end, with the list of
`UsageReport`s that call's STT/TTS/LLM adapter calls produced, rather than
each adapter inserting rows itself (which would scatter billing logic across
every adapter file and make it impossible to reason about "how is cost
computed" from one place).

Cost is computed from `provider_rate_cards` — the platform-wide vendor rate
table Phase 1 created for exactly this purpose (RLS-disabled, not
tenant-scoped, same rationale as the `providers` catalog) — never a
hardcoded number. `db/migrations/009_embedding_layer_and_rate_cards.sql`
seeds a few real rate-card rows (Sarvam STT, Gemini Flash-Lite, and $0
mock-provider rows) as concrete evidence this works, not just a schema
with no data to join against.
"""

from __future__ import annotations

from dataclasses import dataclass

import asyncpg

from ..db import with_tenant
from ..usage import UsageReport

# Converts a UsageReport's `unit` (seconds/characters/tokens — always the
# raw quantity an adapter actually measured) into the `provider_rate_cards
# .unit` convention (per_minute/per_1k_chars/per_1m_tokens — always how a
# vendor prices it) plus the divisor to get from one to the other. Adding a
# new rate-card unit convention (e.g. "per_request") is one more dict entry
# here, not a new code path per provider.
_UNIT_CONVERSIONS: dict[tuple[str, str], float] = {
    ("seconds", "per_minute"): 60.0,
    ("characters", "per_1k_chars"): 1_000.0,
    ("tokens", "per_1m_tokens"): 1_000_000.0,
}


class RateCardNotFoundError(Exception):
    """Raised when no `provider_rate_cards` row exists for a usage report's
    (provider_type, provider_key) — a real data gap that must be visible
    (e.g. surfaced as an alert/log at call end), never silently treated as
    $0 cost, which would hide real vendor spend from the founder."""

    def __init__(self, provider_type: str, provider_key: str):
        super().__init__(
            f'No provider_rate_cards row for provider_type="{provider_type}", '
            f'provider_key="{provider_key}" — insert one (see '
            "db/migrations/009_embedding_layer_and_rate_cards.sql for the pattern) "
            "before this provider can be used for billed calls."
        )


class UnsupportedUnitCombinationError(Exception):
    def __init__(self, usage_unit: str, rate_unit: str):
        super().__init__(
            f'No conversion registered from UsageReport unit "{usage_unit}" to '
            f'provider_rate_cards unit "{rate_unit}" — add one to '
            "_UNIT_CONVERSIONS in voice_gateway/billing/cost_writer.py."
        )


@dataclass(frozen=True)
class WrittenUsageAndCost:
    usage_record_id: str
    cost_record_id: str
    amount_usd: float


def compute_cost_usd(quantity: float, usage_unit: str, rate_unit: str, unit_price_usd: float) -> float:
    """Pure function, deliberately separated from any DB access, so the
    exact math (given a known quantity + a known rate-card row) is testable
    without Postgres — see tests/billing/test_cost_writer.py's pure unit
    test."""
    divisor = _UNIT_CONVERSIONS.get((usage_unit, rate_unit))
    if divisor is None:
        raise UnsupportedUnitCombinationError(usage_unit, rate_unit)
    return (quantity / divisor) * unit_price_usd


async def _load_latest_rate_card(
    conn: asyncpg.Connection, provider_type: str, provider_key: str
) -> asyncpg.Record | None:
    return await conn.fetchrow(
        """
        SELECT unit, unit_price_usd FROM provider_rate_cards
         WHERE provider_type = $1 AND provider_key = $2 AND effective_from <= current_date
         ORDER BY effective_from DESC
         LIMIT 1
        """,
        provider_type,
        provider_key,
    )


async def write_usage_and_cost(
    org_id: str,
    call_id: str | None,
    usage: UsageReport,
    *,
    user_id: str | None = None,
) -> WrittenUsageAndCost:
    """Writes ONE `usage_records` row + its derived `cost_records` row for a
    single `UsageReport`, inside one tenant-scoped transaction (so the two
    rows are always consistent — never a usage row with no matching cost
    row, or vice versa). Raises `RateCardNotFoundError` if no rate card
    covers this provider — see that class's docstring for why this fails
    loudly instead of writing a $0 cost row."""

    async def _write(conn: asyncpg.Connection) -> WrittenUsageAndCost:
        rate_card = await _load_latest_rate_card(conn, usage.layer, usage.provider_key)
        if rate_card is None:
            raise RateCardNotFoundError(usage.layer, usage.provider_key)

        amount_usd = compute_cost_usd(
            usage.quantity, usage.unit, rate_card["unit"], float(rate_card["unit_price_usd"])
        )

        usage_row = await conn.fetchrow(
            """
            INSERT INTO usage_records (org_id, call_id, provider_type, provider_key, quantity, unit)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
            """,
            org_id,
            call_id,
            usage.layer,
            usage.provider_key,
            usage.quantity,
            usage.unit,
        )

        cost_row = await conn.fetchrow(
            """
            INSERT INTO cost_records (org_id, usage_record_id, amount_usd, currency)
            VALUES ($1, $2, $3, 'USD')
            RETURNING id
            """,
            org_id,
            usage_row["id"],
            amount_usd,
        )

        return WrittenUsageAndCost(
            usage_record_id=str(usage_row["id"]), cost_record_id=str(cost_row["id"]), amount_usd=amount_usd
        )

    return await with_tenant(org_id, user_id, _write)


async def write_call_usage(
    org_id: str,
    call_id: str | None,
    usage_reports: list[UsageReport],
    *,
    user_id: str | None = None,
) -> list[WrittenUsageAndCost]:
    """The call-lifecycle entrypoint: writes every `UsageReport` a call's
    STT/TTS/LLM adapter calls produced (typically called once, at call end,
    by whatever holds the accumulated list — see this module's docstring
    for why that's a single writer here rather than each adapter inserting
    its own rows). A `RateCardNotFoundError` for one report does not stop
    the others from being written — a missing rate card for (say) a newly
    added TTS provider should not also lose the call's STT/LLM billing
    data — callers that need all-or-nothing semantics should catch
    exceptions from `write_usage_and_cost` themselves instead."""
    results: list[WrittenUsageAndCost] = []
    for usage in usage_reports:
        results.append(await write_usage_and_cost(org_id, call_id, usage, user_id=user_id))
    return results
