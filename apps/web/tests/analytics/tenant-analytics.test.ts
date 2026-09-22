import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import {
  loadTenantAnalyticsSummary,
  loadTeamPerformance,
  loadCampaignPerformance,
} from "@/lib/analytics/tenant";

/**
 * Phase 9: given known fixture rows (a few calls/leads/cost_records/
 * appointments), the tenant analytics queries produce the exact expected
 * aggregate numbers. Same real-Postgres pattern as tests/crm/pipeline.test.ts.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;
let userId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Tenant Analytics Test Org ${suffix}`,
    `tenant-analytics-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;

  const userRow = await admin.query(
    "INSERT INTO users (org_id, email, password_hash, role, full_name) VALUES ($1, $2, 'x', 'owner', 'Test Salesperson') RETURNING id",
    [orgId, `analytics-user-${suffix}@example.com`]
  );
  userId = userRow.rows[0].id;

  // 3 leads: one hot (won pipeline stage = conversion), one warm, one cold.
  const stageWon = await admin.query(
    `INSERT INTO pipeline_stages (org_id, stage_key, display_name, sort_order, is_terminal, terminal_outcome)
     VALUES ($1, 'won', 'Won', 1, true, 'won') RETURNING id`,
    [orgId]
  );
  const stageWonId = stageWon.rows[0].id;

  const lead1 = await admin.query(
    `INSERT INTO leads (org_id, full_name, phone_number, score_band, pipeline_stage_id, assigned_salesperson_user_id, next_follow_up_at)
     VALUES ($1, 'Hot Lead', '+911111111111', 'hot', $2, $3, now() - interval '1 hour') RETURNING id`,
    [orgId, stageWonId, userId]
  );
  const lead2 = await admin.query(
    `INSERT INTO leads (org_id, full_name, phone_number, score_band, assigned_salesperson_user_id)
     VALUES ($1, 'Warm Lead', '+911111111112', 'warm', $2) RETURNING id`,
    [orgId, userId]
  );
  await admin.query(
    `INSERT INTO leads (org_id, full_name, phone_number, score_band) VALUES ($1, 'Cold Lead', '+911111111113', 'cold')`,
    [orgId]
  );

  // 3 calls: 2 connected (completed/in_progress), 1 failed. Durations 60s and 120s for avg.
  await admin.query(
    `INSERT INTO calls (org_id, lead_id, direction, status, duration_seconds) VALUES ($1, $2, 'outbound', 'completed', 60)`,
    [orgId, lead1.rows[0].id]
  );
  await admin.query(
    `INSERT INTO calls (org_id, lead_id, direction, status, duration_seconds) VALUES ($1, $2, 'outbound', 'in_progress', 120)`,
    [orgId, lead2.rows[0].id]
  );
  await admin.query(`INSERT INTO calls (org_id, direction, status) VALUES ($1, 'outbound', 'failed')`, [orgId]);

  // Cost records: 2.5 total AI cost.
  await admin.query(`INSERT INTO cost_records (org_id, amount_usd, billed_amount) VALUES ($1, 1.5, 3.0)`, [orgId]);
  await admin.query(`INSERT INTO cost_records (org_id, amount_usd, billed_amount) VALUES ($1, 1.0, 2.0)`, [orgId]);

  // 1 scheduled appointment.
  await admin.query(
    `INSERT INTO appointments (org_id, lead_id, scheduled_at, status) VALUES ($1, $2, now() + interval '1 day', 'scheduled')`,
    [orgId, lead1.rows[0].id]
  );

  // Wallet with a known balance.
  await admin.query(`INSERT INTO wallets (org_id, balance) VALUES ($1, 42.5)`, [orgId]);

  // 1 campaign with 1 completed campaign_lead attempt.
  const campaign = await admin.query(
    `INSERT INTO campaigns (org_id, name, status) VALUES ($1, 'Diwali Push', 'active') RETURNING id`,
    [orgId]
  );
  await admin.query(
    `INSERT INTO campaign_leads (org_id, campaign_id, lead_id, status, attempts) VALUES ($1, $2, $3, 'completed', 3)`,
    [orgId, campaign.rows[0].id, lead1.rows[0].id]
  );
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

describe("tenant analytics", () => {
  it("aggregates leads/calls/cost/appointments/wallet exactly from fixture rows", async () => {
    const summary = await loadTenantAnalyticsSummary(orgId, userId);

    expect(summary.totalLeads).toBe(3);
    expect(summary.totalCalls).toBe(3);
    expect(summary.connectedCalls).toBe(2); // completed + in_progress, not failed
    expect(summary.connectedRatePct).toBeCloseTo((2 / 3) * 100, 5);
    expect(summary.avgCallDurationSeconds).toBeCloseTo(90, 5); // (60+120)/2
    expect(summary.qualifiedLeads).toBe(2); // hot + warm
    expect(summary.hotLeads).toBe(1);
    expect(summary.appointmentsScheduled).toBe(1);
    expect(summary.followUpsDue).toBe(1); // lead1's next_follow_up_at is in the past
    expect(summary.conversions).toBe(1); // lead1 is on the 'won' terminal stage
    expect(summary.aiCostUsd).toBeCloseTo(2.5, 5); // 1.5 + 1.0 amount_usd (own cost, not billed_amount)
    expect(summary.walletBalance).toBeCloseTo(42.5, 5);
  });

  it("computes team performance per assigned salesperson", async () => {
    const rows = await loadTeamPerformance(orgId, userId);
    const mine = rows.find((r) => r.userId === userId);
    expect(mine).toBeDefined();
    expect(mine!.assignedLeads).toBe(2); // lead1 + lead2
    expect(mine!.conversions).toBe(1); // lead1
  });

  it("computes campaign performance from campaign_leads", async () => {
    const rows = await loadCampaignPerformance(orgId, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Diwali Push");
    expect(rows[0].totalLeads).toBe(1);
    expect(rows[0].completedLeads).toBe(1);
    expect(rows[0].totalAttempts).toBe(3);
  });
});
