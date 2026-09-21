import { withTenant } from "../db/tenant";

export type AgentPromptRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  version: number;
  inferred_vertical: string | null;
  source: string;
  is_active: boolean;
  created_at: string;
};

/** Lists agent_prompts rows for the caller's org only — proves the
 * auth+tenancy plumbing end-to-end. Empty result is a normal, expected
 * state for a brand-new org (no agents built yet). */
export async function listAgentPrompts(orgId: string, userId: string): Promise<AgentPromptRow[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<AgentPromptRow>(
      `SELECT ap.id, ap.agent_id, a.name AS agent_name, ap.version,
              ap.inferred_vertical, ap.source, ap.is_active, ap.created_at
       FROM agent_prompts ap
       JOIN agents a ON a.id = ap.agent_id
       WHERE ap.org_id = $1
       ORDER BY ap.created_at DESC`,
      [orgId]
    );
    return rows;
  });
}
