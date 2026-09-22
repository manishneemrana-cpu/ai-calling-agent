import { withTenant } from "../db/tenant";

/** Tenant-owned lead scoring criteria — see docs/CRM_LOGIC.md "Why a
 * dedicated table" and services/voice-gateway/voice_gateway/crm/scoring.py
 * for the ruleset that consumes these rows. */

export type ScoringCriterionRow = {
  id: string;
  org_id: string;
  agent_id: string | null;
  criterion_key: string;
  display_name: string;
  weight: number;
  weight_hint: "high" | "medium" | "low" | null;
  is_active: boolean;
};

const WEIGHT_HINT_TO_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };

export type SuggestedScoringCriterion = {
  criterion: string;
  weight_hint?: "high" | "medium" | "low";
};

/** Builds lead_scoring_criteria rows directly from a Prompt-to-Agent
 * Builder's `suggested_lead_scoring_criteria` output
 * (docs/PROMPT_TO_AGENT_BUILDER.md §3), mapping its high/medium/low
 * `weight_hint` to a numeric weight per the documented 3/2/1 default. */
export async function instantiateScoringCriteriaFromSuggestions(
  orgId: string,
  userId: string,
  agentId: string,
  suggestions: SuggestedScoringCriterion[]
): Promise<ScoringCriterionRow[]> {
  return withTenant(orgId, userId, async (client) => {
    const inserted: ScoringCriterionRow[] = [];
    for (const s of suggestions) {
      const key = s.criterion
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const hint = s.weight_hint ?? "medium";
      const { rows } = await client.query<ScoringCriterionRow>(
        `INSERT INTO lead_scoring_criteria (org_id, agent_id, criterion_key, display_name, weight, weight_hint)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, agent_id, criterion_key) DO NOTHING
         RETURNING *`,
        [orgId, agentId, key, s.criterion, WEIGHT_HINT_TO_WEIGHT[hint] ?? 2, hint]
      );
      if (rows[0]) inserted.push(rows[0]);
    }
    return inserted;
  });
}

export async function listScoringCriteria(
  orgId: string,
  userId: string,
  agentId: string | null = null
): Promise<ScoringCriterionRow[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<ScoringCriterionRow>(
      `SELECT * FROM lead_scoring_criteria WHERE org_id = $1 AND (agent_id = $2 OR ($2 IS NULL AND agent_id IS NULL))
       ORDER BY weight DESC, display_name`,
      [orgId, agentId]
    );
    return rows;
  });
}
