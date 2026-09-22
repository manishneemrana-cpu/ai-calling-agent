import type { PoolClient } from "pg";
import { withTenant } from "../db/tenant";

/**
 * Tenant-owned pipeline stages, dispositions, and lead scoring criteria —
 * see db/migrations/010_crm_pipeline.sql and docs/CRM_LOGIC.md. Nothing in
 * here hardcodes a vertical: `instantiatePipelineTemplate` copies from
 * whichever row of the platform-wide `pipeline_stage_templates` catalog
 * the caller names (`generic_default`, `real_estate`, or any future
 * template — pure data, never a code branch), and
 * `instantiateStagesFromSuggestions` builds the same row shape directly
 * from a Prompt-to-Agent Builder's `suggested_pipeline_stages` output
 * instead, for a fully bespoke-per-tenant pipeline.
 */

export type PipelineStage = {
  id: string;
  org_id: string;
  agent_id: string | null;
  stage_key: string;
  display_name: string;
  sort_order: number;
  is_terminal: boolean;
  terminal_outcome: "won" | "lost" | null;
  source_template_key: string | null;
};

export type PipelineStageTemplate = {
  template_key: string;
  display_name: string;
  vertical: string | null;
};

/** Lists the platform-wide pipeline templates (readable by every tenant —
 * see docs/CRM_LOGIC.md "Multi-industry tenant-configurability"). */
export async function listPipelineStageTemplates(orgId: string, userId: string): Promise<PipelineStageTemplate[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<PipelineStageTemplate>(
      "SELECT template_key, display_name, vertical FROM pipeline_stage_templates ORDER BY template_key"
    );
    return rows;
  });
}

/** Copies a named template's stages into this org's (optionally
 * agent-scoped) `pipeline_stages`. Idempotent per (org_id, agent_id,
 * stage_key) — re-running with the same template is a no-op for stages
 * already present (ON CONFLICT DO NOTHING), so calling this again after a
 * partial failure never duplicates rows. */
export async function instantiatePipelineTemplate(
  orgId: string,
  userId: string,
  templateKey: string,
  agentId: string | null = null
): Promise<PipelineStage[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows: templateRows } = await client.query<{ stages: TemplateStage[] }>(
      "SELECT stages FROM pipeline_stage_templates WHERE template_key = $1",
      [templateKey]
    );
    const template = templateRows[0];
    if (!template) {
      throw new Error(`Unknown pipeline_stage_templates.template_key: ${templateKey}`);
    }
    return insertStages(client, orgId, agentId, template.stages, templateKey);
  });
}

type TemplateStage = {
  stage_key: string;
  display_name: string;
  sort_order: number;
  is_terminal: boolean;
  terminal_outcome: "won" | "lost" | null;
};

export type SuggestedPipelineStage = {
  stage_key: string;
  display_name: string;
  is_terminal?: boolean;
  terminal_outcome?: "won" | "lost" | null;
};

/** Builds `pipeline_stages` rows directly from a Prompt-to-Agent Builder's
 * `suggested_pipeline_stages` list (docs/PROMPT_TO_AGENT_BUILDER.md §3),
 * assigning sort_order by array position — for tenants whose builder
 * output IS their pipeline, with no platform template involved. */
export async function instantiateStagesFromSuggestions(
  orgId: string,
  userId: string,
  agentId: string,
  suggestions: SuggestedPipelineStage[]
): Promise<PipelineStage[]> {
  const stages: TemplateStage[] = suggestions.map((s, i) => ({
    stage_key: s.stage_key,
    display_name: s.display_name,
    sort_order: i,
    is_terminal: s.is_terminal ?? false,
    terminal_outcome: s.terminal_outcome ?? null,
  }));
  return withTenant(orgId, userId, (client) => insertStages(client, orgId, agentId, stages, "prompt_to_agent_builder"));
}

async function insertStages(
  client: PoolClient,
  orgId: string,
  agentId: string | null,
  stages: TemplateStage[],
  sourceTemplateKey: string
): Promise<PipelineStage[]> {
  const inserted: PipelineStage[] = [];
  for (const stage of stages) {
    const { rows } = await client.query<PipelineStage>(
      `INSERT INTO pipeline_stages (org_id, agent_id, stage_key, display_name, sort_order, is_terminal, terminal_outcome, source_template_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (org_id, agent_id, stage_key) DO NOTHING
       RETURNING *`,
      [orgId, agentId, stage.stage_key, stage.display_name, stage.sort_order, stage.is_terminal, stage.terminal_outcome, sourceTemplateKey]
    );
    if (rows[0]) inserted.push(rows[0]);
  }
  return inserted;
}

export async function listPipelineStages(
  orgId: string,
  userId: string,
  agentId: string | null = null
): Promise<PipelineStage[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<PipelineStage>(
      `SELECT * FROM pipeline_stages WHERE org_id = $1 AND (agent_id = $2 OR ($2 IS NULL AND agent_id IS NULL))
       ORDER BY sort_order`,
      [orgId, agentId]
    );
    return rows;
  });
}

export type LeadStageHistoryEntry = {
  id: string;
  lead_id: string;
  from_stage_id: string | null;
  to_stage_id: string | null;
  from_stage_name: string | null;
  to_stage_name: string | null;
  changed_by_user_id: string | null;
  note: string | null;
  created_at: string;
};

/**
 * Moves a lead to `toStageId`, always appending one `lead_stage_history`
 * row in the SAME transaction — this is the "every status change
 * timestamped" guarantee, proven append-only. Stage order is
 * intentionally NOT enforced (see docs/CRM_LOGIC.md "Ordered vs. freely
 * jumpable stages") — any to_stage_id belonging to this org/agent is a
 * valid transition from any current stage.
 */
export async function transitionLeadStage(
  orgId: string,
  userId: string | null,
  leadId: string,
  toStageId: string,
  note?: string
): Promise<LeadStageHistoryEntry> {
  return withTenant(orgId, userId, async (client) => {
    const { rows: leadRows } = await client.query<{ pipeline_stage_id: string | null }>(
      "SELECT pipeline_stage_id FROM leads WHERE id = $1 AND org_id = $2",
      [leadId, orgId]
    );
    if (!leadRows[0]) {
      throw new Error(`Lead not found in this org: ${leadId}`);
    }
    const fromStageId = leadRows[0].pipeline_stage_id;

    // Validate the target stage belongs to this org (FORCE RLS already
    // guarantees this for any row we can see at all, but an explicit check
    // gives a clear error instead of a silent no-op update).
    const { rows: targetRows } = await client.query(
      "SELECT id FROM pipeline_stages WHERE id = $1 AND org_id = $2",
      [toStageId, orgId]
    );
    if (!targetRows[0]) {
      throw new Error(`Target pipeline stage not found in this org: ${toStageId}`);
    }

    await client.query("UPDATE leads SET pipeline_stage_id = $1, updated_at = now() WHERE id = $2", [
      toStageId,
      leadId,
    ]);

    const { rows: historyRows } = await client.query<LeadStageHistoryEntry>(
      `WITH inserted AS (
         INSERT INTO lead_stage_history (org_id, lead_id, from_stage_id, to_stage_id, changed_by_user_id, note)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *
       )
       SELECT i.id, i.lead_id, i.from_stage_id, i.to_stage_id,
              fs.display_name AS from_stage_name, ts.display_name AS to_stage_name,
              i.changed_by_user_id, i.note, i.created_at
       FROM inserted i
       LEFT JOIN pipeline_stages fs ON fs.id = i.from_stage_id
       LEFT JOIN pipeline_stages ts ON ts.id = i.to_stage_id`,
      [orgId, leadId, fromStageId, toStageId, userId, note ?? null]
    );
    return historyRows[0];
  });
}

export async function getLeadStageHistory(
  orgId: string,
  userId: string,
  leadId: string
): Promise<LeadStageHistoryEntry[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<LeadStageHistoryEntry>(
      `SELECT h.id, h.lead_id, h.from_stage_id, h.to_stage_id,
              fs.display_name AS from_stage_name, ts.display_name AS to_stage_name,
              h.changed_by_user_id, h.note, h.created_at
       FROM lead_stage_history h
       LEFT JOIN pipeline_stages fs ON fs.id = h.from_stage_id
       LEFT JOIN pipeline_stages ts ON ts.id = h.to_stage_id
       WHERE h.lead_id = $1 AND h.org_id = $2
       ORDER BY h.created_at ASC`,
      [leadId, orgId]
    );
    return rows;
  });
}
