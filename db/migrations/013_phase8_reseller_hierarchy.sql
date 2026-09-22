-- 013_phase8_reseller_hierarchy.sql
-- Phase 8: reseller/white-label hierarchy on TOP of Phase 1's organizations
-- and Phase 7's billing_accounts/wallets/cost_records — no fork of either.
-- See docs/RESELLER_HIERARCHY.md for the full modeling decision + reasoning.
--
-- Hierarchy: Platform Owner -> Reseller -> Customer, modeled as option (a)
-- from the Phase 8 spec: organizations gets `org_role` (platform | reseller
-- | customer) + a nullable self-reference `parent_reseller_id`, rather than
-- a separate `resellers` table. A reseller/customer/platform-owner IS an
-- `organizations` row — it already has its own users, providers, billing
-- (Phase 7's `billing_accounts.reseller_id` extension point, added in
-- 012_phase7_billing.sql specifically for this), so giving it a second,
-- parallel identity table would fork tenant-isolation logic instead of
-- reusing it.

-- ===========================================================================
-- 1. Hierarchy columns on organizations
-- ===========================================================================
ALTER TABLE organizations
  ADD COLUMN org_role text NOT NULL DEFAULT 'customer'
    CHECK (org_role IN ('platform', 'reseller', 'customer')),
  ADD COLUMN parent_reseller_id uuid REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX organizations_parent_reseller_id_idx ON organizations (parent_reseller_id);
CREATE INDEX organizations_org_role_idx ON organizations (org_role);

COMMENT ON COLUMN organizations.org_role IS
  'platform = the platform owner (sees everything); reseller = a white-label reseller (owns customer orgs, buys at a configured rate, sells at their own configured rate); customer = an end tenant, either sold directly by the platform (parent_reseller_id NULL) or resold through a reseller (parent_reseller_id set). Exactly one org should be platform in a real deployment; nothing in this schema enforces that cardinality automatically (documented operational responsibility), same as no schema constraint enforces "exactly one is_default provider" style invariants elsewhere in this codebase beyond the ones that ARE enforced by partial unique indexes.';
COMMENT ON COLUMN organizations.parent_reseller_id IS
  'NULL for the platform owner and for a directly-sold (non-resold) customer. Set to a reseller''s org id for a customer resold through that reseller, or to the platform org''s id for a reseller itself (reseller''s parent is the platform). Self-referencing FK, same table, deliberately reusing the existing organizations/RLS machinery instead of a parallel resellers table.';

-- ===========================================================================
-- 2. current_org_role(): same pattern as current_org_id()/current_app_user_id()
--    (db/migrations/001_extensions_and_core.sql). Set by
--    apps/web/lib/db/tenant.ts's withTenant() from the ACTUAL organizations
--    row (re-derived from the DB every transaction, never trusted from a
--    caller-supplied value or a cached session field) immediately after
--    app.current_org_id is set, so it can never be spoofed independently of
--    which org a connection is actually scoped to.
-- ===========================================================================
CREATE OR REPLACE FUNCTION current_org_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org_role', true), '')
$$;

-- ===========================================================================
-- 3. Lock down provider_rate_cards (platform's REAL vendor cost) to the
--    platform owner only. Before this migration this table had RLS
--    intentionally OFF (see 004_billing_providers.sql) because it carries
--    no org_id and was treated as "not tenant data" — but Phase 8's hard
--    rule is that a reseller (or a reseller's customer) must NEVER see
--    platform-level raw cost data, so it can no longer be openly readable
--    by every tenant connection. Enabling + FORCING RLS here, gated on
--    current_org_role() = 'platform', is what makes this a database-enforced
--    boundary rather than an application-trusted convention — the same
--    standard as every other tenant-isolation policy in this codebase.
--    (`apps/web/lib/billing/costSimulator.ts`'s `loadRateCards` and the
--    `/dashboard/billing/simulator` page that calls it are consequently now
--    platform-owner-only; the Reseller Starter Kit's own cost simulator
--    export, added by this phase, works entirely off the reseller's OWN
--    `reseller_buy_rates`/`reseller_sell_rates` numbers instead and never
--    touches this table.)
-- ===========================================================================
ALTER TABLE provider_rate_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_rate_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_rate_cards_platform_only ON provider_rate_cards
  USING (current_org_role() = 'platform')
  WITH CHECK (current_org_role() = 'platform');

-- internal_lookup_rate_card: the REAL billing pipeline (Phase 3.5/4's
-- cost_writer, both `services/voice-gateway/voice_gateway/billing/
-- cost_writer.py` and `apps/web/lib/billing/costSimulator.ts`'s
-- `loadRateCards`) still needs to read a rate card for EVERY tenant's own
-- calls, regardless of that tenant's org_role — computing a customer's own
-- `cost_records` row is not "browsing the platform cost catalog", it's the
-- system doing its job for that one org's own usage. Blocking that outright
-- would break real per-call billing for every non-platform tenant, which is
-- not what this phase's rule is about.
--
-- This SECURITY DEFINER function is the narrow, safe exception: it returns
-- ONLY the exact (provider_type, provider_key) row asked for — never a way
-- to browse or list the catalog — mirroring the "check inside a narrowly-
-- scoped function, not a blanket table grant" pattern used everywhere else
-- in this migration. HONEST CAVEAT (documented, not hidden): provider_key
-- values themselves are not secret (they're literal adapter names already
-- published in docs/PROVIDER_REGISTRY.md/COST_MODEL_V1.md), so a caller who
-- already knows a specific provider's key could look up that one price this
-- way; what this function does NOT allow is discovering the full set of
-- provider_type/provider_key pairs or their prices in bulk — that remains
-- exclusively behind `provider_rate_cards_platform_only` above.
CREATE OR REPLACE FUNCTION internal_lookup_rate_card(p_provider_type text, p_provider_key text)
RETURNS TABLE(unit text, unit_price_usd numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT unit, unit_price_usd FROM provider_rate_cards
   WHERE provider_type = $1 AND provider_key = $2 AND effective_from <= current_date
   ORDER BY effective_from DESC LIMIT 1;
$$;

REVOKE ALL ON FUNCTION internal_lookup_rate_card(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION internal_lookup_rate_card(text, text) TO app_user;

-- ===========================================================================
-- 4. reseller_branding — white-label config for a reseller's own dashboard
--    chrome (logo/colors/company name/support details) and the
--    subdomain/custom-domain it's reachable at. One row per reseller org.
-- ===========================================================================
CREATE TABLE reseller_branding (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  company_name    text,
  logo_url        text,
  primary_color   text,
  secondary_color text,
  -- Testable white-label routing mechanism for this phase (no real DNS/SSL
  -- infra in a dev sandbox — see docs/RESELLER_HIERARCHY.md "Domain routing"):
  -- {subdomain}.yourplatform.com, resolved by apps/web/lib/reseller/domainResolution.ts
  -- from the Host header or an X-Tenant-Domain override header.
  subdomain       text UNIQUE,
  -- Column only for now — a real reseller.customdomain.com requires DNS
  -- (reseller's CNAME to the platform), a reverse-proxy/host header rule,
  -- and SSL (ACME cert for that domain), none of which exist in this
  -- sandbox. See docs/RESELLER_HIERARCHY.md for the deployment-time
  -- follow-up. This column lets the row model the target state and lets
  -- resolveTenantHost() match on it once that infra exists, with zero
  -- schema change.
  custom_domain   text UNIQUE,
  support_email   text,
  support_phone   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reseller_branding_subdomain_idx ON reseller_branding (subdomain);
CREATE INDEX reseller_branding_custom_domain_idx ON reseller_branding (custom_domain);

-- ===========================================================================
-- 5. reseller_buy_rates — what a reseller pays the PLATFORM per minute (Y in
--    the spec's Z - Y = margin). Deliberately a configured number the
--    platform owner sets, NOT a live join against provider_rate_cards (a
--    reseller is allowed to see this number — it's what THEY pay — but must
--    never see the platform's underlying vendor rate cards it may or may not
--    have been derived from).
--
--    Hard write restriction: app_user gets SELECT only on this table. Every
--    write goes through set_reseller_buy_rate() below, which itself checks
--    current_org_role() = 'platform' before writing anything — so even a
--    compromised/buggy application code path cannot let a reseller (or a
--    customer) set or change their own buy rate; there is no INSERT/UPDATE
--    grant for them to (ab)use in the first place.
-- ===========================================================================
CREATE TABLE reseller_buy_rates (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  buy_price_per_minute_usd  numeric(14,6) NOT NULL,
  currency                  text NOT NULL DEFAULT 'USD',
  set_by_platform_user      text, -- free-text admin identifier/email, same convention as provider_quality_ratings.rated_by
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- 6. reseller_sell_rates — what a reseller charges ITS customers per minute
--    (Z in the spec). Reseller-managed: the reseller sets this for
--    themselves. Granular per-provider markup matrix is explicitly NOT built
--    here (documented reasoning in docs/RESELLER_HIERARCHY.md) — a single
--    configurable sell-rate-per-minute is enough to prove the buy/sell/margin
--    mechanism this phase must demonstrate; per-customer negotiated pricing
--    continues to flow through Phase 7's existing org-scoped `billing_plans`
--    row, unchanged.
-- ===========================================================================
CREATE TABLE reseller_sell_rates (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  sell_price_per_minute_usd numeric(14,6) NOT NULL,
  currency                  text NOT NULL DEFAULT 'USD',
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- 7. reseller_starter_kit_shares — the "cost simulator export" a reseller
--    hands a prospect: a durable, shareable snapshot computed ONLY from that
--    reseller's own buy/sell numbers (never the platform's raw rate cards),
--    readable by anyone holding the opaque share_token (no login required —
--    a prospect is not a platform user), via get_starter_kit_share() below.
-- ===========================================================================
CREATE TABLE reseller_starter_kit_shares (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  share_token                 text NOT NULL UNIQUE,
  prospect_name               text,
  plan_label                  text,
  estimated_minutes_per_month numeric(14,2) NOT NULL,
  -- Snapshots, not live joins: a share link a reseller already handed to a
  -- prospect must keep showing the numbers that were true when it was
  -- created, even if the reseller's rates change later, and must never
  -- become a live window into anything else.
  buy_price_per_minute_usd    numeric(14,6) NOT NULL,
  sell_price_per_minute_usd   numeric(14,6) NOT NULL,
  currency                    text NOT NULL DEFAULT 'USD',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  expires_at                  timestamptz
);
CREATE INDEX reseller_starter_kit_shares_reseller_org_id_idx ON reseller_starter_kit_shares (reseller_org_id);

-- ===========================================================================
-- Grants + RLS
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
  reseller_branding, reseller_sell_rates, reseller_starter_kit_shares
  TO app_user;
-- Deliberately SELECT-only — see reseller_buy_rates comment above.
GRANT SELECT ON reseller_buy_rates TO app_user;

ALTER TABLE reseller_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_branding FORCE ROW LEVEL SECURITY;
CREATE POLICY reseller_branding_isolation ON reseller_branding
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE reseller_buy_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_buy_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY reseller_buy_rates_isolation ON reseller_buy_rates
  USING (org_id = current_org_id());

ALTER TABLE reseller_sell_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_sell_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY reseller_sell_rates_isolation ON reseller_sell_rates
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE reseller_starter_kit_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_starter_kit_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY reseller_starter_kit_shares_isolation ON reseller_starter_kit_shares
  USING (reseller_org_id = current_org_id()) WITH CHECK (reseller_org_id = current_org_id());

-- ===========================================================================
-- 8. set_reseller_buy_rate — the ONLY way reseller_buy_rates is ever
--    written. SECURITY DEFINER so it can write a table app_user has no
--    INSERT/UPDATE grant on at all, but it re-checks current_org_role() =
--    'platform' itself first — it does NOT rely on the missing grant alone,
--    same defense-in-depth standard as credit_wallet_from_payment() trusting
--    only its own DB-side lookups, never a caller-supplied value, for the
--    security-relevant decision.
-- ===========================================================================
CREATE OR REPLACE FUNCTION set_reseller_buy_rate(
  p_reseller_org_id uuid,
  p_buy_price_per_minute_usd numeric,
  p_currency text DEFAULT 'USD',
  p_set_by text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_org_role() <> 'platform' THEN
    RAISE EXCEPTION 'set_reseller_buy_rate: only the platform owner may set a reseller''s buy rate';
  END IF;

  INSERT INTO reseller_buy_rates (org_id, buy_price_per_minute_usd, currency, set_by_platform_user)
    VALUES (p_reseller_org_id, p_buy_price_per_minute_usd, p_currency, p_set_by)
  ON CONFLICT (org_id) DO UPDATE
    SET buy_price_per_minute_usd = EXCLUDED.buy_price_per_minute_usd,
        currency = EXCLUDED.currency,
        set_by_platform_user = EXCLUDED.set_by_platform_user,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION set_reseller_buy_rate(uuid, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_reseller_buy_rate(uuid, numeric, text, text) TO app_user;

-- ===========================================================================
-- 9. promote_org_role — platform-owner-only role changes (customer ->
--    reseller, or setting the one platform org itself). Same
--    check-inside-the-function discipline as set_reseller_buy_rate.
-- ===========================================================================
CREATE OR REPLACE FUNCTION promote_org_role(
  p_target_org_id uuid,
  p_new_role text,
  p_parent_reseller_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_org_role() <> 'platform' THEN
    RAISE EXCEPTION 'promote_org_role: only the platform owner may change an org''s role';
  END IF;
  IF p_new_role NOT IN ('platform', 'reseller', 'customer') THEN
    RAISE EXCEPTION 'promote_org_role: invalid role %', p_new_role;
  END IF;

  UPDATE organizations
     SET org_role = p_new_role,
         parent_reseller_id = COALESCE(p_parent_reseller_id, parent_reseller_id),
         updated_at = now()
   WHERE id = p_target_org_id;
END;
$$;

REVOKE ALL ON FUNCTION promote_org_role(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION promote_org_role(uuid, text, uuid) TO app_user;

-- ===========================================================================
-- 10. create_customer_org — a reseller onboarding their own customer.
--     Mirrors signup_organization()'s atomic org+user creation
--     (006_auth_functions.sql), additionally stamping parent_reseller_id and
--     wiring Phase 7's billing_accounts.reseller_id extension point (added
--     in 012_phase7_billing.sql specifically for this) so the new org's
--     billing is marked reseller_managed from the moment it exists — never
--     a follow-up step that could be skipped.
-- ===========================================================================
CREATE OR REPLACE FUNCTION create_customer_org(
  p_org_name   text,
  p_org_slug   text,
  p_email      citext,
  p_password_hash text,
  p_full_name  text
) RETURNS TABLE(org_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_reseller_id uuid;
  v_org_id uuid;
  v_user_id uuid;
BEGIN
  IF current_org_role() <> 'reseller' THEN
    RAISE EXCEPTION 'create_customer_org: caller must be a reseller org';
  END IF;
  v_reseller_id := current_org_id();

  INSERT INTO organizations (name, slug, org_role, parent_reseller_id)
    VALUES (p_org_name, p_org_slug, 'customer', v_reseller_id)
    RETURNING id INTO v_org_id;

  INSERT INTO users (org_id, email, password_hash, role, full_name)
    VALUES (v_org_id, p_email, p_password_hash, 'owner', p_full_name)
    RETURNING id INTO v_user_id;

  INSERT INTO billing_accounts (org_id, reseller_id, billing_mode, issuing_entity_name)
    VALUES (v_org_id, v_reseller_id, 'reseller_managed', p_org_name);

  RETURN QUERY SELECT v_org_id, v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION create_customer_org(text, text, citext, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_customer_org(text, text, citext, text, text) TO app_user;

-- ===========================================================================
-- 11. resolve_reseller_branding_by_host — white-label domain routing lookup.
--     Runs pre-auth (a visitor hitting {slug}.yourplatform.com has no
--     session/org context yet), so it must bypass RLS the same deliberate
--     way resolve_session() does. Matches on subdomain OR custom_domain,
--     never returns anything else about the reseller org.
-- ===========================================================================
CREATE OR REPLACE FUNCTION resolve_reseller_branding_by_host(p_subdomain text, p_custom_domain text)
RETURNS TABLE(
  org_id uuid, company_name text, logo_url text, primary_color text,
  secondary_color text, support_email text, support_phone text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT rb.org_id, rb.company_name, rb.logo_url, rb.primary_color, rb.secondary_color,
         rb.support_email, rb.support_phone
    FROM reseller_branding rb
   WHERE (p_subdomain IS NOT NULL AND rb.subdomain = p_subdomain)
      OR (p_custom_domain IS NOT NULL AND rb.custom_domain = p_custom_domain)
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION resolve_reseller_branding_by_host(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_reseller_branding_by_host(text, text) TO app_user;

-- ===========================================================================
-- 12. get_starter_kit_share — public (token-authenticated, not
--     session-authenticated) read of one starter-kit share snapshot, for a
--     prospect who has never logged in. Bypasses RLS deliberately (same
--     "no session/org context" rationale as #11), and returns ONLY the
--     snapshot columns — never joins back to reseller_buy_rates/
--     reseller_sell_rates/provider_rate_cards, so a live rate change or the
--     platform's underlying vendor costs can never leak through an old link.
-- ===========================================================================
CREATE OR REPLACE FUNCTION get_starter_kit_share(p_token text)
RETURNS TABLE(
  prospect_name text, plan_label text, estimated_minutes_per_month numeric,
  buy_price_per_minute_usd numeric, sell_price_per_minute_usd numeric,
  currency text, created_at timestamptz, expires_at timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT prospect_name, plan_label, estimated_minutes_per_month,
         buy_price_per_minute_usd, sell_price_per_minute_usd, currency, created_at, expires_at
    FROM reseller_starter_kit_shares
   WHERE share_token = p_token
     AND (expires_at IS NULL OR expires_at > now());
$$;

REVOKE ALL ON FUNCTION get_starter_kit_share(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_starter_kit_share(text) TO app_user;

-- ===========================================================================
-- 13. platform_list_resellers — platform-owner-only cross-tenant view for
--     /dashboard/admin/resellers. SECURITY DEFINER so it can aggregate
--     across every reseller + their customers' REAL cost_records (the
--     platform owner is explicitly allowed to see real platform cost, per
--     the spec), but it re-checks current_org_role() = 'platform' itself —
--     same "check inside the function" standard as every writer above —
--     so it is not just "any app_user connection can call this and get
--     everyone's data" the way platform_provider_cost_stats() was left
--     un-role-gated in Phase 7 (that one has no tenant-identifying data to
--     leak per-org; this one does, so it gets the stricter check).
-- ===========================================================================
CREATE OR REPLACE FUNCTION platform_list_resellers()
RETURNS TABLE(
  reseller_org_id uuid, reseller_name text, company_name text,
  customer_count bigint, buy_price_per_minute_usd numeric, sell_price_per_minute_usd numeric,
  real_platform_cost_usd numeric
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_org_role() <> 'platform' THEN
    RAISE EXCEPTION 'platform_list_resellers: platform-owner only';
  END IF;

  RETURN QUERY
    SELECT o.id, o.name, rb.company_name,
           (SELECT COUNT(*) FROM organizations c WHERE c.parent_reseller_id = o.id),
           br.buy_price_per_minute_usd, sr.sell_price_per_minute_usd,
           COALESCE((
             SELECT SUM(cr.amount_usd) FROM cost_records cr
              WHERE cr.org_id = o.id
                 OR cr.org_id IN (SELECT c.id FROM organizations c WHERE c.parent_reseller_id = o.id)
           ), 0)
      FROM organizations o
      LEFT JOIN reseller_branding rb ON rb.org_id = o.id
      LEFT JOIN reseller_buy_rates br ON br.org_id = o.id
      LEFT JOIN reseller_sell_rates sr ON sr.org_id = o.id
     WHERE o.org_role = 'reseller'
     ORDER BY o.name;
END;
$$;

REVOKE ALL ON FUNCTION platform_list_resellers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_resellers() TO app_user;

-- ===========================================================================
-- 14. resolve_session / find_user_by_email — extended (CREATE OR REPLACE,
--     same established pattern as 007_provider_registry.sql/
--     012_phase7_billing.sql redefining an earlier migration's function) to
--     also return the caller's org's org_role, so apps/web/lib/auth.ts can
--     put orgRole on SessionInfo for every request without a second query.
--     Signatures are unchanged (same params) — only the returned columns
--     grow, so this is additive for every existing caller.
-- ===========================================================================
DROP FUNCTION IF EXISTS resolve_session(text);
CREATE OR REPLACE FUNCTION resolve_session(p_session_id text)
RETURNS TABLE(user_id uuid, org_id uuid, role user_role, org_role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
    SELECT u.id, u.org_id, u.role, o.org_role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN organizations o ON o.id = u.org_id
    WHERE s.id = p_session_id AND s.expires_at > now();
END;
$$;

REVOKE ALL ON FUNCTION resolve_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_session(text) TO app_user;

DROP FUNCTION IF EXISTS find_user_by_email(citext);
CREATE OR REPLACE FUNCTION find_user_by_email(p_email citext)
RETURNS TABLE(user_id uuid, org_id uuid, password_hash text, role user_role, org_role text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.org_id, u.password_hash, u.role, o.org_role
    FROM users u JOIN organizations o ON o.id = u.org_id
   WHERE u.email = p_email;
$$;

REVOKE ALL ON FUNCTION find_user_by_email(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_user_by_email(citext) TO app_user;
