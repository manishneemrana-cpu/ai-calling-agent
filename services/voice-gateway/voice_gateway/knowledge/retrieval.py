"""Retrieval: given a tenant + a query string, return the top-k most
relevant `knowledge_chunks` rows, respecting RLS/tenant scoping — the same
`with_tenant` boundary every other tenant-scoped query in this codebase
uses, so a retrieval call literally cannot see another org's chunks (the
database enforces it, not this function's own care)."""

from __future__ import annotations

from dataclasses import dataclass

import asyncpg

from ..db import with_tenant
from ..registry import get_provider
from .vector_codec import vector_literal

# Below this cosine similarity, a "top match" is not actually relevant —
# without this floor, pgvector's `ORDER BY ... LIMIT k` would always return
# SOME row (the least-dissimilar one in the whole tenant's KB), even for a
# query about something the knowledge base says nothing about, which is
# exactly the "never invent an answer" failure mode this whole feature
# exists to prevent (see grounding.py). Tuned empirically against
# MockEmbeddingProvider's word-hash scheme in
# tests/knowledge/test_ingestion_and_retrieval.py; a real embedding model
# (embedding.gemini) will have a different, similarly-tunable distribution
# — re-tune this constant against real query traffic before go-live.
DEFAULT_MIN_SIMILARITY = 0.15


@dataclass(frozen=True)
class RetrievedChunk:
    content: str
    similarity: float
    knowledge_document_id: str


async def retrieve_top_k(
    org_id: str,
    query: str,
    *,
    k: int = 5,
    user_id: str | None = None,
    min_similarity: float = DEFAULT_MIN_SIMILARITY,
) -> list[RetrievedChunk]:
    """Embeds `query` with this tenant's configured embedding provider, then
    runs a pgvector cosine-distance nearest-neighbor search
    (`embedding <=> query_vector`, pgvector's cosine-distance operator —
    `1 - distance = similarity`) scoped to `org_id`. Chunks below
    `min_similarity` are dropped — an empty result means "nothing relevant
    in this tenant's knowledge base," which `grounding.py` treats as a
    signal to deflect rather than guess."""
    embedding_provider = await get_provider("embedding", org_id, user_id)
    vectors, _usage = await embedding_provider.embed([query])
    query_vector = vector_literal(vectors[0])

    async def _search(conn: asyncpg.Connection) -> list[RetrievedChunk]:
        rows = await conn.fetch(
            """
            SELECT content, knowledge_document_id, 1 - (embedding <=> $1::vector) AS similarity
              FROM knowledge_chunks
             ORDER BY embedding <=> $1::vector
             LIMIT $2
            """,
            query_vector,
            k,
        )
        return [
            RetrievedChunk(
                content=row["content"],
                similarity=float(row["similarity"]),
                knowledge_document_id=str(row["knowledge_document_id"]),
            )
            for row in rows
            if row["similarity"] >= min_similarity
        ]

    return await with_tenant(org_id, user_id, _search)
