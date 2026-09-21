import { withTenant } from "../db/tenant";

export type Organization = {
  id: string;
  name: string;
  slug: string;
  tier: string;
  created_at: string;
};

export async function getCurrentOrganization(orgId: string, userId: string): Promise<Organization | null> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<Organization>(
      "SELECT id, name, slug, tier, created_at FROM organizations WHERE id = $1",
      [orgId]
    );
    return rows[0] ?? null;
  });
}

export async function countOrgUsers(orgId: string, userId: string): Promise<number> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users WHERE org_id = $1",
      [orgId]
    );
    return Number(rows[0]?.count ?? 0);
  });
}
