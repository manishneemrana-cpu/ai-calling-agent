-- 015_phase10_audit_and_rate_limits.sql
-- Phase 10 security hardening.

-- record_audit_event: a SECURITY DEFINER function so application code can
-- write an audit_logs row both inside a tenant-scoped withTenant()
-- transaction AND from a pre-tenant-context call site (login/signup, which
-- run via withoutTenant() before any app.current_org_id is set). Without
-- this, a withoutTenant() connection's INSERT into audit_logs would be
-- rejected by audit_logs' own RLS policy (org_id = current_org_id(), which
-- is NULL outside withTenant()) — the same "pre-auth operations need a
-- SECURITY DEFINER escape hatch" reasoning as signup_organization/
-- create_session in 006_auth_functions.sql, applied to the one other
-- table (audit_logs) that legitimately needs writes from both contexts.
--
-- This does NOT weaken audit_logs' own isolation: the function still takes
-- an explicit org_id and inserts exactly one row scoped to it — it is not
-- a generic RLS-bypass hole, just the standard escape hatch for a table
-- that must be writable before a tenant transaction exists.
CREATE OR REPLACE FUNCTION record_audit_event(
  p_org_id        uuid,
  p_actor_user_id uuid,
  p_action        text,
  p_target_type   text,
  p_target_id     uuid,
  p_metadata      jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO audit_logs (org_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (p_org_id, p_actor_user_id, p_action, p_target_type, p_target_id, COALESCE(p_metadata, '{}'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION record_audit_event(uuid, uuid, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_audit_event(uuid, uuid, text, text, uuid, jsonb) TO app_user;

-- auth_rate_limit_events: backs the Phase 10 login/signup rate limiter
-- (apps/web/lib/security/rateLimit.ts). Postgres-backed rather than
-- in-memory specifically because Next.js in production typically runs as
-- multiple serverless/edge instances with no shared process memory — an
-- in-memory limiter would silently reset per-instance and undercount
-- attempts. This is the same "Postgres-backed default, Redis-backed the
-- documented production upgrade" pattern Phase 6 already established for
-- the job queue (see QUEUE_BACKEND in .env.example and
-- db/migrations/011_phase6_whatsapp_appointments_campaigns_compliance.sql).
-- No org_id / RLS here on purpose: rate-limit keys are pre-auth (an IP
-- address or an email string), not tenant data.
CREATE TABLE auth_rate_limit_events (
  id          bigserial PRIMARY KEY,
  bucket_key  text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_rate_limit_events_bucket_time_idx
  ON auth_rate_limit_events (bucket_key, occurred_at);

GRANT SELECT, INSERT, DELETE ON auth_rate_limit_events TO app_user;
GRANT USAGE, SELECT ON SEQUENCE auth_rate_limit_events_id_seq TO app_user;

-- Phase 10: wire the three highest-value platform-owner/reseller SECURITY
-- DEFINER mutations (013_phase8_reseller_hierarchy.sql) into audit_logs
-- directly inside the function, rather than relying on every future
-- TypeScript call site to remember to log it separately — these functions
-- are the ONLY way these rows are ever written (same "check inside the
-- function" discipline the role checks below already use), so this is the
-- one place that's guaranteed to see every real invocation, including a
-- future admin tool this phase does not build.
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

  INSERT INTO audit_logs (org_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (
      p_reseller_org_id, current_app_user_id(), 'reseller.buy_rate_set', 'reseller_buy_rates', p_reseller_org_id,
      jsonb_build_object('buyPricePerMinuteUsd', p_buy_price_per_minute_usd, 'currency', p_currency)
    );
END;
$$;

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

  INSERT INTO audit_logs (org_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (
      p_target_org_id, current_app_user_id(), 'org.role_promoted', 'organizations', p_target_org_id,
      jsonb_build_object('newRole', p_new_role, 'parentResellerId', p_parent_reseller_id)
    );
END;
$$;

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

  INSERT INTO audit_logs (org_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (
      v_reseller_id, current_app_user_id(), 'reseller.customer_org_created', 'organizations', v_org_id,
      jsonb_build_object('customerOrgName', p_org_name)
    );

  RETURN QUERY SELECT v_org_id, v_user_id;
END;
$$;
