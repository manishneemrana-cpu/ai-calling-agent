"""Part B: proves (1) the pure cost-computation math against known
numbers, with no DB, and (2) the full write path — given known usage
numbers and a seeded rate-card row, the computed `cost_records` row matches
expected math, AND a cost record can't be attributed to or read by the
wrong org (tenant isolation), extending the existing suite's pattern
(tests/test_tenant_isolation.py)."""

from __future__ import annotations

import os
import uuid

import asyncpg
import pytest

from voice_gateway.billing.cost_writer import (
    RateCardNotFoundError,
    UnsupportedUnitCombinationError,
    compute_cost_usd,
    write_call_usage,
    write_usage_and_cost,
)
from voice_gateway.usage import UsageReport

ADMIN_URL = os.environ.get(
    "DATABASE_URL_MIGRATE", "postgresql://postgres:postgres@localhost:5432/ai_calling_agent"
)
APP_URL = os.environ.get(
    "DATABASE_URL", "postgresql://app_user:app_user_dev_password@localhost:5432/ai_calling_agent"
)


# ---------------------------------------------------------------- pure ----


def test_compute_cost_usd_seconds_per_minute():
    # 90 seconds of STT at $0.006/min -> 1.5 min * $0.006 = $0.009
    assert compute_cost_usd(90.0, "seconds", "per_minute", 0.006) == pytest.approx(0.009)


def test_compute_cost_usd_characters_per_1k_chars():
    # 2,500 characters of TTS at ₹30/10,000 chars expressed as $3.6/1k chars
    # -> 2.5 * 3.6 = $9.00
    assert compute_cost_usd(2500.0, "characters", "per_1k_chars", 3.6) == pytest.approx(9.0)


def test_compute_cost_usd_tokens_per_1m_tokens():
    # 250,000 tokens at $0.10/M tokens -> 0.25 * 0.10 = $0.025
    assert compute_cost_usd(250_000.0, "tokens", "per_1m_tokens", 0.10) == pytest.approx(0.025)


def test_compute_cost_usd_rejects_unsupported_combination():
    with pytest.raises(UnsupportedUnitCombinationError):
        compute_cost_usd(1.0, "tokens", "per_minute", 1.0)


# ---------------------------------------------------------- integration ----
# asyncio_mode = "auto" (pyproject.toml) auto-detects the async tests below —
# no module-level `pytestmark` needed (and one would incorrectly tag the
# pure sync tests above with an asyncio marker, which pytest-asyncio warns
# about).


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
async def two_orgs_with_rate_card(admin_conn: asyncpg.Connection):
    suffix = uuid.uuid4().hex[:8]
    provider_key = f"test_stt_{suffix}"

    row_a = await admin_conn.fetchrow(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        f"VG Cost Writer Test Org A {suffix}",
        f"vg-cost-writer-org-a-{suffix}",
    )
    row_b = await admin_conn.fetchrow(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        f"VG Cost Writer Test Org B {suffix}",
        f"vg-cost-writer-org-b-{suffix}",
    )
    org_a, org_b = str(row_a["id"]), str(row_b["id"])

    # A known, seeded rate card: $0.01/minute of STT for this test-only
    # provider_key — the test asserts the exact math this produces.
    await admin_conn.execute(
        "INSERT INTO provider_rate_cards (provider_type, provider_key, unit, unit_price_usd) "
        "VALUES ('stt', $1, 'per_minute', 0.01)",
        provider_key,
    )

    yield org_a, org_b, provider_key

    await admin_conn.execute("DELETE FROM provider_rate_cards WHERE provider_key = $1", provider_key)
    await admin_conn.execute(
        "DELETE FROM organizations WHERE id = ANY($1)", [uuid.UUID(org_a), uuid.UUID(org_b)]
    )


@pytest.fixture(autouse=True)
async def _reset_pool(monkeypatch):
    from voice_gateway import db as db_module

    monkeypatch.setenv("DATABASE_URL", APP_URL)
    yield
    await db_module.close_pool()


async def test_write_usage_and_cost_matches_expected_math(admin_conn, two_orgs_with_rate_card):
    org_a, _org_b, provider_key = two_orgs_with_rate_card

    # 150 seconds (2.5 min) of STT at $0.01/min -> exactly $0.025.
    usage = UsageReport(provider_key=provider_key, layer="stt", unit="seconds", quantity=150.0)
    result = await write_usage_and_cost(org_a, None, usage)

    assert result.amount_usd == pytest.approx(0.025)

    # Re-read it back as org A, straight from the tables — proves the
    # writer's numbers are what's actually persisted, not just what the
    # function returned in-process.
    async def _read(conn: asyncpg.Connection):
        usage_row = await conn.fetchrow(
            "SELECT quantity, unit, provider_key FROM usage_records WHERE id = $1",
            uuid.UUID(result.usage_record_id),
        )
        cost_row = await conn.fetchrow(
            "SELECT amount_usd, currency FROM cost_records WHERE id = $1", uuid.UUID(result.cost_record_id)
        )
        return usage_row, cost_row

    from voice_gateway.db import with_tenant

    usage_row, cost_row = await with_tenant(org_a, None, _read)
    assert usage_row["quantity"] == pytest.approx(150.0)
    assert usage_row["unit"] == "seconds"
    assert usage_row["provider_key"] == provider_key
    assert float(cost_row["amount_usd"]) == pytest.approx(0.025)
    assert cost_row["currency"] == "USD"


async def test_missing_rate_card_raises_instead_of_writing_zero_cost(admin_conn, two_orgs_with_rate_card):
    org_a, _org_b, _provider_key = two_orgs_with_rate_card
    usage = UsageReport(provider_key="no-such-provider", layer="llm", unit="tokens", quantity=1000.0)
    with pytest.raises(RateCardNotFoundError):
        await write_usage_and_cost(org_a, None, usage)


async def test_write_call_usage_writes_multiple_reports_for_one_call(admin_conn, two_orgs_with_rate_card):
    org_a, _org_b, provider_key = two_orgs_with_rate_card
    reports = [
        UsageReport(provider_key=provider_key, layer="stt", unit="seconds", quantity=60.0),
        UsageReport(provider_key=provider_key, layer="stt", unit="seconds", quantity=30.0),
    ]
    results = await write_call_usage(org_a, None, reports)
    assert [r.amount_usd for r in results] == pytest.approx([0.01, 0.005])


async def test_cost_record_cannot_be_attributed_to_or_read_by_the_wrong_org(
    admin_conn, two_orgs_with_rate_card
):
    """Tenant isolation for Part B: org B can never see org A's cost/usage
    rows (RLS, same boundary tests/test_tenant_isolation.py already proves
    for other tables), and an attempt to write a cost/usage row under one
    org's session but attributed to another org's id is rejected by
    FORCE ROW LEVEL SECURITY's WITH CHECK — not silently redirected."""
    org_a, org_b, provider_key = two_orgs_with_rate_card

    usage = UsageReport(provider_key=provider_key, layer="stt", unit="seconds", quantity=120.0)
    result = await write_usage_and_cost(org_a, None, usage)

    from voice_gateway.db import with_tenant

    async def _read_as_org_b(conn: asyncpg.Connection):
        usage_rows = await conn.fetch(
            "SELECT id FROM usage_records WHERE id = $1", uuid.UUID(result.usage_record_id)
        )
        cost_rows = await conn.fetch(
            "SELECT id FROM cost_records WHERE id = $1", uuid.UUID(result.cost_record_id)
        )
        return usage_rows, cost_rows

    usage_rows, cost_rows = await with_tenant(org_b, None, _read_as_org_b)
    assert usage_rows == []  # org B cannot see org A's usage_records row
    assert cost_rows == []  # org B cannot see org A's cost_records row

    async def _try_insert_cost_for_org_a_while_scoped_as_org_b(conn: asyncpg.Connection):
        await conn.execute(
            "INSERT INTO cost_records (org_id, amount_usd, currency) VALUES ($1, 1.00, 'USD')",
            uuid.UUID(org_a),
        )

    with pytest.raises(asyncpg.PostgresError):
        await with_tenant(org_b, None, _try_insert_cost_for_org_a_while_scoped_as_org_b)
