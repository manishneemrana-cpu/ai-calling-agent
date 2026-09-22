import type { PoolClient } from "pg";

/**
 * Phase 9 platform-owner analytics — reads `platform_analytics_summary()`
 * (db/migrations/014_phase9_observability_failover.sql), a SECURITY
 * DEFINER function that deliberately aggregates ACROSS every tenant, same
 * category as `platform_provider_cost_stats()` (Phase 7's Provider
 * Scoreboard). Callers MUST gate this to `session.orgRole === "platform"`
 * before calling — see app/dashboard/admin/analytics/page.tsx — this
 * module itself does not check the session, exactly like
 * lib/billing/scoreboard.ts's loaders.
 */
export type PlatformAnalyticsSummary = {
  totalTenants: number;
  activeTenants: number;
  callsToday: number;
  connectedCallsToday: number;
  totalMinutesAllTime: number;
  totalAiCostUsd: number;
  totalRevenue: number;
  grossMarginUsd: number;
  activeAgents: number;
  activeCampaigns: number;
  hotLeads: number;
  appointmentsScheduled: number;
  failedCallsToday: number;
};

export async function loadPlatformAnalyticsSummary(client: PoolClient): Promise<PlatformAnalyticsSummary> {
  const { rows } = await client.query(`SELECT * FROM platform_analytics_summary()`);
  const r = rows[0];
  const totalAiCostUsd = Number(r.total_ai_cost_usd);
  const totalRevenue = Number(r.total_revenue);
  return {
    totalTenants: Number(r.total_tenants),
    activeTenants: Number(r.active_tenants),
    callsToday: Number(r.calls_today),
    connectedCallsToday: Number(r.connected_calls_today),
    totalMinutesAllTime: Number(r.total_minutes_all_time),
    totalAiCostUsd,
    totalRevenue,
    grossMarginUsd: totalRevenue - totalAiCostUsd,
    activeAgents: Number(r.active_agents),
    activeCampaigns: Number(r.active_campaigns),
    hotLeads: Number(r.hot_leads),
    appointmentsScheduled: Number(r.appointments_scheduled),
    failedCallsToday: Number(r.failed_calls_today),
  };
}

export type ResellerAnalyticsSummary = {
  totalTenants: number;
  callsToday: number;
  connectedCallsToday: number;
  totalMinutesAllTime: number;
  totalAiCostUsd: number;
  totalRevenue: number;
  grossMarginUsd: number;
  hotLeads: number;
  appointmentsScheduled: number;
  failedCallsToday: number;
};

/**
 * Reseller-scoped equivalent — `reseller_analytics_summary(orgId)` limits
 * the aggregate to the reseller's own org + its customer orgs
 * (parent_reseller_id = orgId), per Phase 8's hard rule that a reseller
 * never sees platform-wide raw cost. Callers MUST pass the CALLER'S OWN
 * session.orgId (never an arbitrary org id) and gate to
 * `session.orgRole === "reseller"` first.
 */
export async function loadResellerAnalyticsSummary(
  client: PoolClient,
  resellerOrgId: string
): Promise<ResellerAnalyticsSummary> {
  const { rows } = await client.query(`SELECT * FROM reseller_analytics_summary($1)`, [resellerOrgId]);
  const r = rows[0];
  const totalAiCostUsd = Number(r.total_ai_cost_usd);
  const totalRevenue = Number(r.total_revenue);
  return {
    totalTenants: Number(r.total_tenants),
    callsToday: Number(r.calls_today),
    connectedCallsToday: Number(r.connected_calls_today),
    totalMinutesAllTime: Number(r.total_minutes_all_time),
    totalAiCostUsd,
    totalRevenue,
    grossMarginUsd: totalRevenue - totalAiCostUsd,
    hotLeads: Number(r.hot_leads),
    appointmentsScheduled: Number(r.appointments_scheduled),
    failedCallsToday: Number(r.failed_calls_today),
  };
}
