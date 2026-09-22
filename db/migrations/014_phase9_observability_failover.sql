-- 014_phase9_observability_failover.sql
-- Phase 9: observability/latency-wiring, provider failover, analytics.
--
-- Ranked multi-provider-per-layer support ALREADY EXISTS since Phase 2
-- (tenant_provider_config.priority + is_default — see
-- 007_provider_registry.sql). No schema change is needed there: failover
-- just reads every tenant_provider_config row for (org_id, layer) ordered
-- by (is_default DESC, priority ASC) instead of only the first one. This
-- migration adds only what's genuinely new for Phase 9: the failover event
-- ledger, and platform-wide analytics aggregation functions mirroring the
-- Phase 7 platform_provider_cost_stats() pattern (docs/COST_MODEL_V1.md /
-- docs/RESELLER_HIERARCHY.md's cost-visibility rule: platform-wide raw cost
-- is never exposed to a reseller or tenant).

-- ===========================================================================
-- 1. provider_failover_events — one row per failover attempt (a primary/
--    higher-priority provider's call throwing or timing out, causing a
--    retry against the next-priority configured provider for that layer).
--    Feeds the Phase 7 Provider Scoreboard's future "how often does X
--    provider fail" view (not built in this migration — this is the ledger
--    it will read from).
-- ===========================================================================
CREATE TABLE provider_failover_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE, -- nullable: a failover can happen before a call is fully attributed to a tenant, same rationale as call_latency_metrics.org_id
  layer           text NOT NULL, -- 'telephony' | 'stt' | 'tts' | 'llm' | 'whatsapp' | 'payment_gateway' | 'embedding' — not CHECK-constrained to the providers.layer set so a new layer never needs a migration here too
  from_provider   text NOT NULL,
  to_provider     text NOT NULL,
  reason          text NOT NULL, -- e.g. 'timeout', 'exception: <message>', 'all_providers_exhausted'
  call_id         uuid REFERENCES calls(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_failover_events_org_id_idx ON provider_failover_events (org_id);
CREATE INDEX provider_failover_events_layer_provider_idx ON provider_failover_events (layer, from_provider);

GRANT SELECT, INSERT ON provider_failover_events TO app_user;

ALTER TABLE provider_failover_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_failover_events FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_failover_events_isolation ON provider_failover_events
  USING (org_id IS NULL OR org_id = current_org_id())
  WITH CHECK (org_id IS NULL OR org_id = current_org_id());

-- Platform owner needs to see failover events across every tenant (same
-- "how often does X provider fail" cross-tenant concern as the Provider
-- Scoreboard) — a SECURITY DEFINER read function, gated in application code
-- to org_role = 'platform' exactly like platform_provider_cost_stats().
CREATE OR REPLACE FUNCTION platform_failover_stats()
RETURNS TABLE(layer text, from_provider text, to_provider text, event_count bigint, last_event_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT layer, from_provider, to_provider, count(*)::bigint, max(created_at)
    FROM provider_failover_events
   GROUP BY layer, from_provider, to_provider
   ORDER BY layer, from_provider;
$$;
REVOKE ALL ON FUNCTION platform_failover_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_failover_stats() TO app_user;

-- ===========================================================================
-- 2. Platform-wide analytics aggregation — admin dashboard
--    (/dashboard/admin/analytics). Same SECURITY DEFINER pattern as
--    platform_provider_cost_stats(): deliberately crosses every tenant's
--    RLS boundary, so it is gated to org_role = 'platform' in application
--    code (apps/web/lib/analytics/platform.ts), never exposed to a
--    reseller or customer session.
-- ===========================================================================
CREATE OR REPLACE FUNCTION platform_analytics_summary()
RETURNS TABLE(
  total_tenants          bigint,
  active_tenants         bigint, -- had >=1 call in the last 30 days
  calls_today            bigint,
  connected_calls_today  bigint,
  total_minutes_all_time numeric,
  total_ai_cost_usd      numeric,
  total_revenue          numeric, -- sum of billed_amount (what tenants were charged)
  active_agents          bigint,
  active_campaigns       bigint,
  hot_leads              bigint,
  appointments_scheduled bigint,
  failed_calls_today     bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (SELECT count(*) FROM organizations)::bigint,
    (SELECT count(DISTINCT org_id) FROM calls WHERE created_at >= now() - interval '30 days')::bigint,
    (SELECT count(*) FROM calls WHERE created_at >= date_trunc('day', now()))::bigint,
    (SELECT count(*) FROM calls WHERE created_at >= date_trunc('day', now()) AND status IN ('completed', 'in_progress'))::bigint,
    (SELECT coalesce(sum(duration_seconds), 0) / 60.0 FROM calls)::numeric,
    (SELECT coalesce(sum(amount_usd), 0) FROM cost_records)::numeric,
    (SELECT coalesce(sum(billed_amount), 0) FROM cost_records)::numeric,
    (SELECT count(*) FROM agents WHERE status = 'active')::bigint,
    (SELECT count(*) FROM campaigns WHERE status = 'active')::bigint,
    (SELECT count(*) FROM leads WHERE score_band = 'hot')::bigint,
    (SELECT count(*) FROM appointments WHERE status IN ('scheduled', 'confirmed'))::bigint,
    (SELECT count(*) FROM calls WHERE created_at >= date_trunc('day', now()) AND status = 'failed')::bigint;
$$;
REVOKE ALL ON FUNCTION platform_analytics_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_analytics_summary() TO app_user;

-- Reseller-scoped equivalent: same shape, but limited to a reseller's own
-- org plus its customer orgs (parent_reseller_id = the reseller) — per
-- Phase 8's hard rule, a reseller NEVER sees platform-wide raw cost, only
-- its own tenants' aggregates. p_reseller_org_id is application-supplied
-- (from the caller's own session.orgId, never a caller-chosen arbitrary
-- org), and application code additionally checks org_role = 'reseller'
-- before calling this.
CREATE OR REPLACE FUNCTION reseller_analytics_summary(p_reseller_org_id uuid)
RETURNS TABLE(
  total_tenants          bigint,
  calls_today            bigint,
  connected_calls_today  bigint,
  total_minutes_all_time numeric,
  total_ai_cost_usd      numeric,
  total_revenue          numeric,
  hot_leads              bigint,
  appointments_scheduled bigint,
  failed_calls_today     bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH scope AS (
    SELECT id FROM organizations WHERE id = p_reseller_org_id OR parent_reseller_id = p_reseller_org_id
  )
  SELECT
    (SELECT count(*) FROM scope)::bigint,
    (SELECT count(*) FROM calls c JOIN scope s ON s.id = c.org_id WHERE c.created_at >= date_trunc('day', now()))::bigint,
    (SELECT count(*) FROM calls c JOIN scope s ON s.id = c.org_id WHERE c.created_at >= date_trunc('day', now()) AND c.status IN ('completed', 'in_progress'))::bigint,
    (SELECT coalesce(sum(c.duration_seconds), 0) / 60.0 FROM calls c JOIN scope s ON s.id = c.org_id)::numeric,
    (SELECT coalesce(sum(cr.amount_usd), 0) FROM cost_records cr JOIN scope s ON s.id = cr.org_id)::numeric,
    (SELECT coalesce(sum(cr.billed_amount), 0) FROM cost_records cr JOIN scope s ON s.id = cr.org_id)::numeric,
    (SELECT count(*) FROM leads l JOIN scope s ON s.id = l.org_id WHERE l.score_band = 'hot')::bigint,
    (SELECT count(*) FROM appointments a JOIN scope s ON s.id = a.org_id WHERE a.status IN ('scheduled', 'confirmed'))::bigint,
    (SELECT count(*) FROM calls c JOIN scope s ON s.id = c.org_id WHERE c.created_at >= date_trunc('day', now()) AND c.status = 'failed')::bigint;
$$;
REVOKE ALL ON FUNCTION reseller_analytics_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reseller_analytics_summary(uuid) TO app_user;
