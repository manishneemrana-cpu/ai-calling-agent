-- 016_gap_closing_pass.sql
-- Gap-closing pass (post-Phase 10 audit): the Prompt-to-Agent Builder
-- itself needs no schema change (it writes into agent_prompts /
-- pipeline_stages / dispositions / lead_scoring_criteria, all of which
-- already exist per 003_agents_leads_calls.sql / 010_crm_pipeline.sql).
-- This migration closes two of the audit's other findings that ARE cheap
-- schema-level fixes:
--
-- 1. Per-tenant n8n webhook tokens (docs/N8N_WORKFLOWS.md's "Deferred"
--    section) — Phase 6 shipped one shared secret + an explicit orgId
--    field/env var per n8n instance; a leaked shared secret let a caller
--    address ANY org's n8n endpoints if they also knew/guessed that org's
--    id. This adds a real per-tenant token table + a token->org resolver,
--    so `apps/web/lib/webhooks/n8n-auth.ts` can resolve the trusted org
--    from the token alone (never from a caller-supplied `orgId`).
--
-- 2. A DB constraint enforcing `organizations.parent_reseller_id`
--    validity (docs/PRODUCTION_CHECKLIST.md Category D) — previously only
--    guaranteed by `promote_org_role()`/`create_customer_org()` being the
--    sole intended write paths, with no schema-level backstop against a
--    direct UPDATE setting a nonsensical parent (e.g. a customer's
--    parent_reseller_id pointing at another customer, or at an org with
--    no reseller/platform role at all).

-- ===========================================================================
-- 1. n8n_webhook_tokens — one per-tenant token per org, replacing the
--    Phase 6 shared-secret model. Only the HASH is stored (never the raw
--    token), same discipline as `sessions`/`users.password_hash` — a DB
--    leak must not itself hand out working tokens.
-- ===========================================================================
CREATE TABLE n8n_webhook_tokens (
  org_id      uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON n8n_webhook_tokens TO app_user;

ALTER TABLE n8n_webhook_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE n8n_webhook_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY n8n_webhook_tokens_isolation ON n8n_webhook_tokens
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- resolve_org_by_n8n_token: the pre-auth lookup an incoming n8n webhook
-- needs (no session/org context exists yet — same rationale as
-- resolve_session()/get_starter_kit_share()). Takes the SHA-256 hex digest
-- of the raw token (hashed by the caller, same convention as
-- resolve_session() taking a pre-hashed session token) and returns the
-- owning org id, or no rows if the token is unknown/never configured —
-- callers must treat "no row" as a hard auth failure, never a fallback to
-- any other trust mechanism.
CREATE OR REPLACE FUNCTION resolve_org_by_n8n_token(p_token_hash text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT org_id FROM n8n_webhook_tokens WHERE token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION resolve_org_by_n8n_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_org_by_n8n_token(text) TO app_user;

-- ===========================================================================
-- 2. parent_reseller_id validity — a trigger-enforced invariant instead of
--    "only guaranteed by two functions behaving correctly". Valid values:
--    NULL (platform owner, or a directly-sold customer), or the id of an
--    org whose OWN org_role is 'reseller' or 'platform' (per
--    013_phase8_reseller_hierarchy.sql's own comment: "reseller's parent
--    is the platform"). A plain CHECK constraint can't reference another
--    row, so this needs a trigger — still a schema-level backstop, not an
--    application-trusted convention.
-- ===========================================================================
CREATE OR REPLACE FUNCTION validate_parent_reseller_id() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_parent_role text;
BEGIN
  IF NEW.parent_reseller_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_reseller_id = NEW.id THEN
    RAISE EXCEPTION 'organizations.parent_reseller_id: an org cannot be its own parent (%)', NEW.id;
  END IF;

  SELECT org_role INTO v_parent_role FROM organizations WHERE id = NEW.parent_reseller_id;
  IF v_parent_role IS NULL THEN
    RAISE EXCEPTION 'organizations.parent_reseller_id: no such org %', NEW.parent_reseller_id;
  END IF;
  IF v_parent_role NOT IN ('reseller', 'platform') THEN
    RAISE EXCEPTION
      'organizations.parent_reseller_id must reference a reseller or the platform org (target org_role = %)',
      v_parent_role;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_validate_parent_reseller_id
  BEFORE INSERT OR UPDATE OF parent_reseller_id ON organizations
  FOR EACH ROW EXECUTE FUNCTION validate_parent_reseller_id();

-- ===========================================================================
-- 3. Provider Scoreboard failover-frequency stats — no schema change
--    needed (platform_failover_stats() already exists, see
--    014_phase9_observability_failover.sql); this migration's job is just
--    to document that apps/web/lib/billing/scoreboard.ts /
--    /dashboard/admin/provider-scoreboard now actually call it (see that
--    code change in this same gap-closing pass commit).
-- ===========================================================================
