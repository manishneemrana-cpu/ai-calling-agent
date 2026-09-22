import type { PoolClient } from "pg";
import { withTenant } from "../db/tenant";

/** Tenant-owned dispositions — same template/suggestions dual-path as
 * lib/crm/pipeline.ts, see docs/CRM_LOGIC.md. */

export type Disposition = {
  id: string;
  org_id: string;
  agent_id: string | null;
  disposition_key: string;
  display_name: string;
  category: string | null;
  source_template_key: string | null;
};

type TemplateDisposition = {
  disposition_key: string;
  display_name: string;
  category: string | null;
};

export async function instantiateDispositionTemplate(
  orgId: string,
  userId: string,
  templateKey: string,
  agentId: string | null = null
): Promise<Disposition[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<{ dispositions: TemplateDisposition[] }>(
      "SELECT dispositions FROM disposition_templates WHERE template_key = $1",
      [templateKey]
    );
    const template = rows[0];
    if (!template) {
      throw new Error(`Unknown disposition_templates.template_key: ${templateKey}`);
    }
    return insertDispositions(client, orgId, agentId, template.dispositions, templateKey);
  });
}

export type SuggestedDisposition = { disposition_key: string; display_name: string; category?: string | null };

export async function instantiateDispositionsFromSuggestions(
  orgId: string,
  userId: string,
  agentId: string,
  suggestions: SuggestedDisposition[]
): Promise<Disposition[]> {
  const dispositions: TemplateDisposition[] = suggestions.map((s) => ({
    disposition_key: s.disposition_key,
    display_name: s.display_name,
    category: s.category ?? null,
  }));
  return withTenant(orgId, userId, (client) =>
    insertDispositions(client, orgId, agentId, dispositions, "prompt_to_agent_builder")
  );
}

async function insertDispositions(
  client: PoolClient,
  orgId: string,
  agentId: string | null,
  dispositions: TemplateDisposition[],
  sourceTemplateKey: string
): Promise<Disposition[]> {
  const inserted: Disposition[] = [];
  for (const d of dispositions) {
    const { rows } = await client.query<Disposition>(
      `INSERT INTO dispositions (org_id, agent_id, disposition_key, display_name, category, source_template_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, agent_id, disposition_key) DO NOTHING
       RETURNING *`,
      [orgId, agentId, d.disposition_key, d.display_name, d.category, sourceTemplateKey]
    );
    if (rows[0]) inserted.push(rows[0]);
  }
  return inserted;
}

export async function listDispositions(
  orgId: string,
  userId: string,
  agentId: string | null = null
): Promise<Disposition[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<Disposition>(
      `SELECT * FROM dispositions WHERE org_id = $1 AND (agent_id = $2 OR ($2 IS NULL AND agent_id IS NULL))
       ORDER BY display_name`,
      [orgId, agentId]
    );
    return rows;
  });
}

/** Records a call's classified disposition on the lead (last_disposition_id)
 * — the DB-write half of the classifier in
 * services/voice-gateway/voice_gateway/crm/dispositions.py, whose pure
 * classification function this simply persists the result of. */
export async function setLeadDisposition(
  orgId: string,
  userId: string | null,
  leadId: string,
  dispositionId: string
): Promise<void> {
  await withTenant(orgId, userId, async (client) => {
    await client.query("UPDATE leads SET last_disposition_id = $1, updated_at = now() WHERE id = $2 AND org_id = $3", [
      dispositionId,
      leadId,
      orgId,
    ]);
  });
}
