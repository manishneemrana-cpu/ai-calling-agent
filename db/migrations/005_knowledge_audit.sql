-- 005_knowledge_audit.sql
-- Knowledge base (RAG source-of-truth so the agent never invents business
-- facts — see docs/ARCHITECTURE.md and the founder's master prompt) and
-- audit logs. Phase 1: schema only, no ingestion/retrieval pipeline yet
-- (that's Phase 4), but the pgvector column is real and indexed.

CREATE TABLE knowledge_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id      uuid REFERENCES agents(id) ON DELETE SET NULL,
  title         text NOT NULL,
  category      text, -- e.g. "product catalog", "pricing/FAQs", "policy documents"
  source_type   text NOT NULL DEFAULT 'manual', -- manual | upload | url
  source_uri    text,
  status        text NOT NULL DEFAULT 'pending', -- pending | processed | failed
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_documents_org_id_idx ON knowledge_documents (org_id);

-- 768 dims chosen as a common embedding size (e.g. Gemini text-embedding);
-- revisit alongside whichever embedding model Phase 4 finalizes.
CREATE TABLE knowledge_chunks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  knowledge_document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index           integer NOT NULL DEFAULT 0,
  content               text NOT NULL,
  embedding             vector(768),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_chunks_org_id_idx ON knowledge_chunks (org_id);
CREATE INDEX knowledge_chunks_document_id_idx ON knowledge_chunks (knowledge_document_id);
-- ivfflat index deferred to Phase 4 (needs data present + ANALYZE to be
-- meaningful; an empty-table index would just be dead weight in Phase 1).

CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL, -- e.g. 'agent.created', 'agent_prompt.updated'
  target_type   text,
  target_id     uuid,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_id_idx ON audit_logs (org_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_documents, knowledge_chunks, audit_logs TO app_user;

ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_documents_isolation ON knowledge_documents
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_chunks_isolation ON knowledge_chunks
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_isolation ON audit_logs
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
