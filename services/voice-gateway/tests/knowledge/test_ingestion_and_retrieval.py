"""Ingests a small fake knowledge base for tenant A using MockEmbeddingProvider
(no live embedding API key needed), and proves:
  1. retrieval returns relevant chunks for a matching query,
  2. retrieval returns NOTHING for a query unrelated to anything in the KB
     (the min-similarity floor — see retrieval.py), and
  3. tenant B's retrieval never sees tenant A's chunks — extends the
     existing tenant-isolation suite's pattern
     (tests/test_tenant_isolation.py) to knowledge_chunks/knowledge_documents.
"""

from __future__ import annotations

import json
import os
import uuid

import asyncpg
import pytest

from voice_gateway.knowledge.ingest import ingest_document
from voice_gateway.knowledge.retrieval import retrieve_top_k

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
async def two_orgs_with_mock_embedding(admin_conn: asyncpg.Connection):
    suffix = uuid.uuid4().hex[:8]
    row_a = await admin_conn.fetchrow(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        f"VG Knowledge Test Org A {suffix}",
        f"vg-kb-test-org-a-{suffix}",
    )
    row_b = await admin_conn.fetchrow(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        f"VG Knowledge Test Org B {suffix}",
        f"vg-kb-test-org-b-{suffix}",
    )
    org_a, org_b = str(row_a["id"]), str(row_b["id"])
    for org_id in (org_a, org_b):
        await admin_conn.execute(
            "INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config) "
            "VALUES ($1, 'embedding', 'mock', true, 1, $2)",
            uuid.UUID(org_id),
            json.dumps({}),
        )
    yield org_a, org_b
    await admin_conn.execute(
        "DELETE FROM organizations WHERE id = ANY($1)", [uuid.UUID(org_a), uuid.UUID(org_b)]
    )


@pytest.fixture(autouse=True)
async def _reset_pool(monkeypatch):
    from voice_gateway import db as db_module

    monkeypatch.setenv("DATABASE_URL", APP_URL)
    yield
    await db_module.close_pool()


RETURN_POLICY_TEXT = (
    "Our return policy allows returns within 7 days of delivery for a full refund. "
    "Refunds are processed to the original payment method within 3 to 5 business days."
)
PRICING_TEXT = (
    "The Pro plan costs 999 rupees per month and includes priority support. "
    "The Basic plan costs 299 rupees per month with standard support."
)


async def test_retrieval_returns_relevant_chunks_for_a_matching_query(
    admin_conn, two_orgs_with_mock_embedding
):
    org_a, _org_b = two_orgs_with_mock_embedding
    await ingest_document(org_a, "Return Policy FAQ", RETURN_POLICY_TEXT, category="policy")
    await ingest_document(org_a, "Pricing FAQ", PRICING_TEXT, category="pricing")

    results = await retrieve_top_k(org_a, "What is your return policy for refunds?", k=3)

    assert len(results) > 0
    assert any("return policy" in r.content.lower() or "refund" in r.content.lower() for r in results)


async def test_retrieval_returns_nothing_for_an_unrelated_query(admin_conn, two_orgs_with_mock_embedding):
    org_a, _org_b = two_orgs_with_mock_embedding
    await ingest_document(org_a, "Return Policy FAQ", RETURN_POLICY_TEXT, category="policy")
    await ingest_document(org_a, "Pricing FAQ", PRICING_TEXT, category="pricing")

    results = await retrieve_top_k(org_a, "elephant giraffe rocket telescope volcano", k=3)

    assert results == []


async def test_tenant_b_retrieval_never_sees_tenant_a_chunks(admin_conn, two_orgs_with_mock_embedding):
    org_a, org_b = two_orgs_with_mock_embedding
    await ingest_document(org_a, "Return Policy FAQ", RETURN_POLICY_TEXT, category="policy")

    # Org B has NO documents ingested at all — any hit here would be a
    # cross-tenant leak, not just a low-relevance miss.
    results_as_b = await retrieve_top_k(org_b, "What is your return policy for refunds?", k=5)
    assert results_as_b == []

    # Now give org B its own, DIFFERENT knowledge base and confirm org A's
    # query still only ever surfaces org A's own content.
    await ingest_document(org_b, "Org B Pricing", PRICING_TEXT, category="pricing")
    results_as_a_again = await retrieve_top_k(org_a, "What is your return policy for refunds?", k=5)
    assert all("rupees" not in r.content.lower() for r in results_as_a_again)
