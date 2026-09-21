"""Ingestion: raw text -> chunks -> embeddings -> `knowledge_documents` +
`knowledge_chunks` rows, tenant-scoped.

Embeddings are resolved via the SAME Provider Registry every other layer
uses (`voice_gateway.registry.get_provider("embedding", ...)`) — this
module never imports a concrete embedding adapter or branches on
provider_key, per docs/PROVIDER_REGISTRY.md.

pgvector wire format note: `asyncpg` has no built-in codec for pgvector's
`vector` type, so embeddings are sent as a Postgres array-literal string
(`"[0.1,0.2,...]"`) and cast with an explicit `::vector` in the SQL text —
the standard, documented way to use pgvector from asyncpg without adding a
custom type codec.
"""

from __future__ import annotations

import asyncpg

from ..db import with_tenant
from ..registry import get_provider
from .chunking import chunk_text
from .vector_codec import vector_literal


async def ingest_document(
    org_id: str,
    title: str,
    raw_text: str,
    *,
    user_id: str | None = None,
    agent_id: str | None = None,
    category: str | None = None,
    max_chars: int = 500,
    overlap_chars: int = 50,
) -> str:
    """Chunks `raw_text`, embeds every chunk (one batched `embed()` call via
    this tenant's configured embedding provider), and inserts one
    `knowledge_documents` row plus one `knowledge_chunks` row per chunk, all
    in a single tenant-scoped transaction. Returns the new document's id.
    A document with zero chunks (blank text) is still created — with
    `status = 'failed'` — rather than silently no-oping, so a tenant admin
    UI has something to show for an empty upload."""
    chunks = chunk_text(raw_text, max_chars=max_chars, overlap_chars=overlap_chars)

    embedding_provider = await get_provider("embedding", org_id, user_id)
    vectors: list[list[float]] = []
    if chunks:
        vectors, _usage = await embedding_provider.embed(chunks)
        if len(vectors) != len(chunks):
            raise RuntimeError(f"embedding provider returned {len(vectors)} vectors for {len(chunks)} chunks")

    async def _write(conn: asyncpg.Connection) -> str:
        doc_row = await conn.fetchrow(
            """
            INSERT INTO knowledge_documents (org_id, agent_id, title, category, source_type, status)
            VALUES ($1, $2, $3, $4, 'manual', $5)
            RETURNING id
            """,
            org_id,
            agent_id,
            title,
            category,
            "processed" if chunks else "failed",
        )
        document_id = doc_row["id"]

        for index, (chunk, vector) in enumerate(zip(chunks, vectors, strict=True)):
            await conn.execute(
                """
                INSERT INTO knowledge_chunks (org_id, knowledge_document_id, chunk_index, content, embedding)
                VALUES ($1, $2, $3, $4, $5::vector)
                """,
                org_id,
                document_id,
                index,
                chunk,
                vector_literal(vector),
            )
        return str(document_id)

    return await with_tenant(org_id, user_id, _write)
