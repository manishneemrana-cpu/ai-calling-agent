import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { createOutboundCall, ZeroBalanceBlockedError } from "@/lib/calls/createCall";
import { processCampaignDialJob } from "@/lib/campaigns/dialer";
import { assertWalletHasBalance } from "@/lib/billing/callGuard";
import { withTenant } from "@/lib/db/tenant";

/**
 * The zero-balance-blocking proof suite — same rigor/standard as
 * apps/web/tests/compliance/gate.test.ts: every known call-creation path
 * (direct `createOutboundCall()` and the campaign dialer) is blocked for a
 * prepaid_wallet tenant with balance <= 0, and zero `calls` rows are ever
 * inserted.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;
let leadId: string;
let planId: string;

beforeAll(async () => {
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY ??= "test-only-encryption-key-do-not-use-in-prod";
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Zero Balance Test Org ${suffix}`,
    `zero-balance-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;

  await admin.query(
    `INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
     VALUES ($1, 'telephony', 'mock', true, 1, '{}'::jsonb)`,
    [orgId]
  );

  const planRow = await admin.query(
    `INSERT INTO billing_plans (name, plan_type, rate_config) VALUES ('Prepaid Test Plan', 'prepaid_wallet', '{"per_minute_rate": 2.99}'::jsonb) RETURNING id`
  );
  planId = planRow.rows[0].id;
  await admin.query(
    `INSERT INTO billing_accounts (org_id, plan_id, issuing_entity_name) VALUES ($1, $2, 'Zero Balance Test Org')`,
    [orgId, planId]
  );
  await admin.query(`INSERT INTO wallets (org_id, balance) VALUES ($1, 0)`, [orgId]);

  const leadRow = await admin.query(
    "INSERT INTO leads (org_id, full_name, phone_number) VALUES ($1, 'Zero Balance Lead', '+919000000001') RETURNING id",
    [orgId]
  );
  leadId = leadRow.rows[0].id;
  await admin.query(
    `INSERT INTO lead_compliance (org_id, lead_id, consent_status, is_dnd, opted_out, consent_captured_at)
     VALUES ($1, $2, 'granted', false, false, now())`,
    [orgId, leadId]
  );
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.query("DELETE FROM billing_plans WHERE id = $1", [planId]);
  await admin.end();
});

beforeEach(async () => {
  await admin.query("UPDATE wallets SET balance = 0 WHERE org_id = $1", [orgId]);
  await admin.query("DELETE FROM calls WHERE org_id = $1", [orgId]);
});

describe("Zero-balance gate — direct unit check", () => {
  it("blocks a prepaid_wallet org with balance 0", async () => {
    await withTenant(orgId, null, async (client) => {
      await expect(assertWalletHasBalance(client, orgId)).rejects.toBeInstanceOf(ZeroBalanceBlockedError);
    });
  });

  it("allows once the wallet has a positive balance", async () => {
    await admin.query("UPDATE wallets SET balance = 100 WHERE org_id = $1", [orgId]);
    await withTenant(orgId, null, async (client) => {
      await expect(assertWalletHasBalance(client, orgId)).resolves.toBeUndefined();
    });
  });
});

describe("Zero-balance gate — PROOF every call-creation path is blocked", () => {
  it("PATH 1 (direct/manual createOutboundCall): blocked, and never inserts a calls row", async () => {
    const { rows: before } = await admin.query("SELECT count(*)::int AS c FROM calls WHERE org_id = $1", [orgId]);

    await expect(
      createOutboundCall({
        orgId,
        userId: null,
        toNumber: "+919000000001",
        fromNumber: "+919999999999",
        leadId,
      })
    ).rejects.toBeInstanceOf(ZeroBalanceBlockedError);

    const { rows: after } = await admin.query("SELECT count(*)::int AS c FROM calls WHERE org_id = $1", [orgId]);
    expect(after[0].c).toBe(before[0].c);

    const { rows: alerts } = await admin.query(
      `SELECT alert_type FROM billing_alerts WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orgId]
    );
    expect(alerts[0].alert_type).toBe("call_blocked");
  });

  it("PATH 2 (campaign dialer job handler): blocked the same way, marks campaign_leads 'blocked', zero calls placed", async () => {
    const campaignRow = await admin.query(
      `INSERT INTO campaigns (org_id, name, status, calling_days, calling_hour_start, calling_hour_end)
       VALUES ($1, 'Zero Balance Campaign', 'active', '{1,2,3,4,5,6,7}', 0, 24) RETURNING id`,
      [orgId]
    );
    const campaignId = campaignRow.rows[0].id;
    await admin.query(
      `INSERT INTO campaign_leads (org_id, campaign_id, lead_id, status) VALUES ($1, $2, $3, 'pending')`,
      [orgId, campaignId, leadId]
    );

    await processCampaignDialJob({ orgId, campaignId, leadId });

    const { rows } = await admin.query(
      `SELECT status, blocked_reason FROM campaign_leads WHERE org_id = $1 AND campaign_id = $2 AND lead_id = $3`,
      [orgId, campaignId, leadId]
    );
    expect(rows[0].status).toBe("blocked");
    expect(rows[0].blocked_reason).toMatch(/balance/);

    const { rows: calls } = await admin.query("SELECT count(*)::int AS c FROM calls WHERE org_id = $1", [orgId]);
    expect(calls[0].c).toBe(0);

    await admin.query("DELETE FROM campaign_leads WHERE campaign_id = $1", [campaignId]);
    await admin.query("DELETE FROM campaigns WHERE id = $1", [campaignId]);
  });

  it("a subscription-plan org (not wallet-gated) is NOT blocked by this check even at wallet balance 0", async () => {
    const subPlanRow = await admin.query(
      `INSERT INTO billing_plans (name, plan_type, rate_config) VALUES ('Sub Test Plan', 'subscription', '{"monthly_fee": 999}'::jsonb) RETURNING id`
    );
    await admin.query(`UPDATE billing_accounts SET plan_id = $2 WHERE org_id = $1`, [orgId, subPlanRow.rows[0].id]);

    await withTenant(orgId, null, async (client) => {
      await expect(assertWalletHasBalance(client, orgId)).resolves.toBeUndefined();
    });

    await admin.query(`UPDATE billing_accounts SET plan_id = $2 WHERE org_id = $1`, [orgId, planId]);
    await admin.query("DELETE FROM billing_plans WHERE id = $1", [subPlanRow.rows[0].id]);
  });
});
