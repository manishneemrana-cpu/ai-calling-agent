import { withTenant } from "../db/tenant";

export type LeadListRow = {
  id: string;
  full_name: string | null;
  phone_number: string | null;
  pipeline_stage_name: string | null;
  score: number;
  score_band: "hot" | "warm" | "cold" | null;
  last_disposition_name: string | null;
  next_follow_up_at: string | null;
  updated_at: string;
};

/** Lists leads for the caller's org, joined against this phase's tenant-owned
 * pipeline_stages/dispositions — proves the CRM schema/API work end-to-end
 * (see apps/web/app/dashboard/leads/page.tsx). */
export async function listLeads(orgId: string, userId: string): Promise<LeadListRow[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<LeadListRow>(
      `SELECT l.id, l.full_name, l.phone_number,
              ps.display_name AS pipeline_stage_name,
              l.score, l.score_band,
              d.display_name AS last_disposition_name,
              l.next_follow_up_at, l.updated_at
       FROM leads l
       LEFT JOIN pipeline_stages ps ON ps.id = l.pipeline_stage_id
       LEFT JOIN dispositions d ON d.id = l.last_disposition_id
       WHERE l.org_id = $1
       ORDER BY l.updated_at DESC`,
      [orgId]
    );
    return rows;
  });
}

export type LeadDetail = LeadListRow & {
  email: string | null;
  agent_id: string | null;
  assigned_salesperson_user_id: string | null;
};

export async function getLead(orgId: string, userId: string, leadId: string): Promise<LeadDetail | null> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<LeadDetail>(
      `SELECT l.id, l.full_name, l.phone_number, l.email, l.agent_id, l.assigned_salesperson_user_id,
              ps.display_name AS pipeline_stage_name,
              l.score, l.score_band,
              d.display_name AS last_disposition_name,
              l.next_follow_up_at, l.updated_at
       FROM leads l
       LEFT JOIN pipeline_stages ps ON ps.id = l.pipeline_stage_id
       LEFT JOIN dispositions d ON d.id = l.last_disposition_id
       WHERE l.org_id = $1 AND l.id = $2`,
      [orgId, leadId]
    );
    return rows[0] ?? null;
  });
}

export type CallSummaryRow = {
  id: string;
  call_id: string;
  requirement_text: string | null;
  budget_value: string | null;
  location: string | null;
  product_type: string | null;
  intent: string | null;
  objections: string[];
  next_action: string | null;
  follow_up_date: string | null;
  lead_score_at_call: number | null;
  recommended_action: string | null;
  needs_review: boolean;
  created_at: string;
};

export async function getLeadCallSummaries(orgId: string, userId: string, leadId: string): Promise<CallSummaryRow[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<CallSummaryRow>(
      `SELECT id, call_id, requirement_text, budget_value, location, product_type, intent,
              objections, next_action, follow_up_date, lead_score_at_call, recommended_action,
              needs_review, created_at
       FROM call_summaries WHERE org_id = $1 AND lead_id = $2 ORDER BY created_at DESC`,
      [orgId, leadId]
    );
    return rows;
  });
}
