import { randomBytes } from "crypto";
import { withTenant } from "@/lib/db/tenant";
import { hashN8nToken } from "@/lib/webhooks/n8n-auth";

/**
 * Generates and stores this org's per-tenant n8n webhook token
 * (db/migrations/016_gap_closing_pass.sql's `n8n_webhook_tokens`). Returns
 * the RAW token exactly once — only its hash is ever persisted, same
 * discipline as a password — the caller (the dashboard action) must show
 * it to the tenant immediately and never log/store it in plaintext
 * anywhere else. Calling this again rotates the token (old one stops
 * working immediately, since only one row per org exists).
 */
export async function rotateN8nWebhookToken(orgId: string, userId: string): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashN8nToken(rawToken);
  await withTenant(orgId, userId, async (client) => {
    await client.query(
      `INSERT INTO n8n_webhook_tokens (org_id, token_hash, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_by = EXCLUDED.created_by, updated_at = now()`,
      [orgId, tokenHash, userId]
    );
  });
  return rawToken;
}

export async function hasN8nWebhookToken(orgId: string, userId: string): Promise<boolean> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query("SELECT 1 FROM n8n_webhook_tokens WHERE org_id = $1", [orgId]);
    return rows.length > 0;
  });
}
