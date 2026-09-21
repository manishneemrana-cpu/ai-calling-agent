"""Knowledge-base ingestion / retrieval / grounding — Phase 3.5 Part C,
Phase 4's foundational scaffold.

Per the spec's non-negotiable rule: the AI must NEVER invent
business-specific facts (price, availability, policy, etc.) — it answers
only from an approved per-tenant knowledge base
(`knowledge_documents`/`knowledge_chunks`, pgvector — Phase 1 schema,
unused until now).

- `chunking.py` — pure text-chunking, no I/O.
- `ingest.py` — chunk + embed (via the `embedding` Provider Registry layer)
  + INSERT into `knowledge_documents`/`knowledge_chunks`, tenant-scoped.
- `retrieval.py` — pgvector cosine-similarity top-k search, tenant-scoped
  (RLS-enforced, same boundary as every other tenant table).
- `grounding.py` — the actual, testable prompt-construction function that
  wires retrieval into the LLM adapter layer as an optional grounding step:
  injects retrieved chunks when there are any, or instructs the LLM to
  deflect (the spec's own example line) when there are none.
"""
