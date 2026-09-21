-- 001_extensions_and_core.sql
-- Extensions, the non-tenant-scoped app role, and helper functions used by RLS policies.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector, for knowledge_chunks embeddings

-- Application DB role: the Next.js app connects as this role, never as the
-- migration/superuser role. It must NOT have BYPASSRLS, and tables below are
-- created with FORCE ROW LEVEL SECURITY so even the table owner's session
-- (if it ever connected as app_user) can't skip RLS. This is what makes
-- tenant isolation a database-enforced boundary rather than an
-- application-trusted convention.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user_dev_password' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- current_org_id(): reads the per-transaction session variable the app sets
-- via `SET LOCAL app.current_org_id = '<uuid>'` at the start of every
-- request/transaction (see apps/web/lib/db/tenant.ts). RLS policies key off
-- this function. It returns NULL (matching nothing) if unset, so a
-- connection that forgets to set it sees zero rows rather than everything.
CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

-- current_user_id(): same pattern, for audit_logs / "created_by" style checks.
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;
