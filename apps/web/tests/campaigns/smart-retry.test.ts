import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { scheduleNextAttempt } from "@/lib/campaigns/dialer";

/**
 * Smart-retry schedule tests: attempt 1 immediate, 2 after 30min, 3 after
 * 4h, 4 next day (the spec's example, and this migration's default
 * `campaigns.retry_schedule`), with a hard `max_attempts` cap regardless
 * of disposition.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;
let leadId: string;
let campaignId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Retry Test Org ${suffix}`,
    `retry-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;

  const leadRow = await admin.query("INSERT INTO leads (org_id, full_name) VALUES ($1, 'Retry Lead') RETURNING id", [
    orgId,
  ]);
  leadId = leadRow.rows[0].id;

  const campaignRow = await admin.query(
    `INSERT INTO campaigns (org_id, name, status, max_attempts) VALUES ($1, 'Retry Campaign', 'active', 4) RETURNING id`,
    [orgId]
  );
  campaignId = campaignRow.rows[0].id;

  await admin.query(
    `INSERT INTO campaign_leads (org_id, campaign_id, lead_id, status, attempts) VALUES ($1, $2, $3, 'in_progress', 1)`,
    [orgId, campaignId, leadId]
  );
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

describe("Smart retry schedule", () => {
  it("schedules attempt 2 ~30 minutes out on a no_answer disposition", async () => {
    await scheduleNextAttempt({ orgId, campaignId, leadId, disposition: "no_answer" });
    const { rows } = await admin.query(
      "SELECT status, next_attempt_at FROM campaign_leads WHERE campaign_id = $1 AND lead_id = $2",
      [campaignId, leadId]
    );
    expect(rows[0].status).toBe("pending");
    const deltaMinutes = (new Date(rows[0].next_attempt_at).getTime() - Date.now()) / 60_000;
    expect(deltaMinutes).toBeGreaterThan(25);
    expect(deltaMinutes).toBeLessThan(35);
  });

  it("a terminal disposition (connected) marks the lead completed, not retried", async () => {
    await scheduleNextAttempt({ orgId, campaignId, leadId, disposition: "connected" });
    const { rows } = await admin.query(
      "SELECT status, last_disposition FROM campaign_leads WHERE campaign_id = $1 AND lead_id = $2",
      [campaignId, leadId]
    );
    expect(rows[0].status).toBe("completed");
    expect(rows[0].last_disposition).toBe("connected");
  });

  it("hits the hard max_attempts cap: exhausted, not scheduled for a 5th attempt", async () => {
    await admin.query(
      "UPDATE campaign_leads SET status = 'in_progress', attempts = 4 WHERE campaign_id = $1 AND lead_id = $2",
      [campaignId, leadId]
    );
    await scheduleNextAttempt({ orgId, campaignId, leadId, disposition: "no_answer" });
    const { rows } = await admin.query(
      "SELECT status FROM campaign_leads WHERE campaign_id = $1 AND lead_id = $2",
      [campaignId, leadId]
    );
    expect(rows[0].status).toBe("exhausted");
  });
});
