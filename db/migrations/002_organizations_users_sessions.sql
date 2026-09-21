-- 002_organizations_users_sessions.sql
-- Tenants (organizations), users, and auth sessions. Not tenant-scoped rows
-- themselves (organizations IS the tenant table; users belong to one org).

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  -- White-label branding stub (Phase 1: columns only, no UI for it yet).
  branding      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Which tier/provider-preset this org runs on (Economy/Premium etc.) —
  -- never a hardcoded provider name in code, just a config key looked up
  -- against provider_rate_cards / provider_accounts.
  tier          text NOT NULL DEFAULT 'economy',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'agent_manager', 'viewer');

-- citext extension needed for case-insensitive unique email; must exist
-- before it's referenced in the users table below.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           citext,
  password_hash   text NOT NULL,
  role            user_role NOT NULL DEFAULT 'owner',
  full_name       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_unique ON users (email);
CREATE INDEX users_org_id_idx ON users (org_id);

-- Server-side sessions (hand-rolled auth, see PHASE1_DECISIONS.md). Only a
-- SHA-256 hash of the session token is stored, never the raw token.
CREATE TABLE sessions (
  id              text PRIMARY KEY, -- sha256(token) hex
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, users, sessions TO app_user;

-- RLS: organizations. A member can only ever see their own org row. Signup
-- (creating the very first org+user) happens via a dedicated SECURITY
-- DEFINER function (see 006_signup_function.sql) so it can bypass this
-- chicken-and-egg "no org context yet" problem safely.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_isolation ON organizations
  USING (id = current_org_id())
  WITH CHECK (id = current_org_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_isolation ON users
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

-- Sessions are looked up by id (token hash) *before* org context is known
-- (that's how login/session-resolution bootstraps the org context in the
-- first place), so sessions cannot be scoped by current_org_id(). Instead
-- we scope by current_user_id() once known, OR allow lookup-by-id for the
-- login/session-resolution path via a SECURITY DEFINER function
-- (see 006_signup_function.sql: resolve_session / login are SECURITY
-- DEFINER and are the only supported way the app touches this table).
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_no_direct_access ON sessions
  USING (false) WITH CHECK (false);
