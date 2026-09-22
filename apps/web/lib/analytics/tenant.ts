import { withTenant } from "../db/tenant";

/**
 * Phase 9 tenant-scoped analytics — every query here goes through
 * `withTenant`, so RLS scopes every read to the CALLING org only (never
 * platform-wide cost — see lib/analytics/platform.ts for that,
 * platform-owner-only). Built as real queries against Phase 5/6/7's
 * existing tables (calls, leads, cost_records, appointments, wallets,
 * campaigns/campaign_leads) — no new tables needed for the tenant view.
 */
export type TenantAnalyticsSummary = {
  totalLeads: number;
  totalCalls: number;
  connectedCalls: number;
  connectedRatePct: number;
  avgCallDurationSeconds: number;
  qualifiedLeads: number;
  hotLeads: number;
  appointmentsScheduled: number;
  followUpsDue: number;
  conversions: number;
  aiCostUsd: number; // this tenant's own cost_records total, never platform-wide
  walletBalance: number;
};

export async function loadTenantAnalyticsSummary(orgId: string, userId: string | null): Promise<TenantAnalyticsSummary> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query(
      `SELECT
         (SELECT count(*) FROM leads WHERE org_id = $1) AS total_leads,
         (SELECT count(*) FROM calls WHERE org_id = $1) AS total_calls,
         (SELECT count(*) FROM calls WHERE org_id = $1 AND status IN ('completed', 'in_progress')) AS connected_calls,
         (SELECT coalesce(avg(duration_seconds), 0) FROM calls WHERE org_id = $1 AND duration_seconds IS NOT NULL) AS avg_call_duration_seconds,
         (SELECT count(*) FROM leads WHERE org_id = $1 AND score_band IN ('hot', 'warm')) AS qualified_leads,
         (SELECT count(*) FROM leads WHERE org_id = $1 AND score_band = 'hot') AS hot_leads,
         (SELECT count(*) FROM appointments WHERE org_id = $1 AND status IN ('scheduled', 'confirmed')) AS appointments_scheduled,
         (SELECT count(*) FROM leads WHERE org_id = $1 AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= now()) AS follow_ups_due,
         (SELECT count(*) FROM leads l JOIN pipeline_stages ps ON ps.id = l.pipeline_stage_id
            WHERE l.org_id = $1 AND ps.terminal_outcome = 'won') AS conversions,
         (SELECT coalesce(sum(amount_usd), 0) FROM cost_records WHERE org_id = $1) AS ai_cost_usd,
         (SELECT coalesce(balance, 0) FROM wallets WHERE org_id = $1) AS wallet_balance
      `,
      [orgId]
    );
    const r = rows[0];
    const totalCalls = Number(r.total_calls);
    const connectedCalls = Number(r.connected_calls);
    return {
      totalLeads: Number(r.total_leads),
      totalCalls,
      connectedCalls,
      connectedRatePct: totalCalls === 0 ? 0 : (connectedCalls / totalCalls) * 100,
      avgCallDurationSeconds: Number(r.avg_call_duration_seconds),
      qualifiedLeads: Number(r.qualified_leads),
      hotLeads: Number(r.hot_leads),
      appointmentsScheduled: Number(r.appointments_scheduled),
      followUpsDue: Number(r.follow_ups_due),
      conversions: Number(r.conversions),
      aiCostUsd: Number(r.ai_cost_usd),
      walletBalance: Number(r.wallet_balance),
    };
  });
}

export type TeamPerformanceRow = {
  userId: string;
  fullName: string | null;
  assignedLeads: number;
  conversions: number;
};

export async function loadTeamPerformance(orgId: string, userId: string | null): Promise<TeamPerformanceRow[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query(
      `SELECT u.id AS user_id, u.full_name,
              count(l.id) AS assigned_leads,
              count(l.id) FILTER (WHERE ps.terminal_outcome = 'won') AS conversions
         FROM users u
         LEFT JOIN leads l ON l.assigned_salesperson_user_id = u.id AND l.org_id = $1
         LEFT JOIN pipeline_stages ps ON ps.id = l.pipeline_stage_id
        WHERE u.org_id = $1
        GROUP BY u.id, u.full_name
        ORDER BY assigned_leads DESC`,
      [orgId]
    );
    return rows.map((r) => ({
      userId: r.user_id,
      fullName: r.full_name,
      assignedLeads: Number(r.assigned_leads),
      conversions: Number(r.conversions),
    }));
  });
}

export type CampaignPerformanceRow = {
  campaignId: string;
  name: string;
  status: string;
  totalLeads: number;
  completedLeads: number;
  totalAttempts: number;
};

export async function loadCampaignPerformance(orgId: string, userId: string | null): Promise<CampaignPerformanceRow[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query(
      `SELECT c.id AS campaign_id, c.name, c.status,
              count(cl.id) AS total_leads,
              count(cl.id) FILTER (WHERE cl.status = 'completed') AS completed_leads,
              coalesce(sum(cl.attempts), 0) AS total_attempts
         FROM campaigns c
         LEFT JOIN campaign_leads cl ON cl.campaign_id = c.id
        WHERE c.org_id = $1
        GROUP BY c.id, c.name, c.status
        ORDER BY c.created_at DESC`,
      [orgId]
    );
    return rows.map((r) => ({
      campaignId: r.campaign_id,
      name: r.name,
      status: r.status,
      totalLeads: Number(r.total_leads),
      completedLeads: Number(r.completed_leads),
      totalAttempts: Number(r.total_attempts),
    }));
  });
}
