import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { withoutTenant } from "@/lib/db/tenant";
import { loadPlatformAnalyticsSummary, loadResellerAnalyticsSummary } from "@/lib/analytics/platform";

/**
 * Phase 9: given known fixture rows across TWO orgs (platform-wide view
 * must sum across both), the platform analytics function produces the
 * expected aggregates, and the reseller-scoped function correctly limits
 * itself to only its own + its customer orgs (Phase 8 visibility rule).
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgA: string; // reseller
let orgB: string; // orgA's customer
let orgC: string; // unrelated org, must NOT count in orgA's reseller view

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const suffix = randomUUID().slice(0, 8);
  const a = await admin.query(
    "INSERT INTO organizations (name, slug, org_role) VALUES ($1, $2, 'reseller') RETURNING id",
    [`Platform Analytics Reseller ${suffix}`, `platform-analytics-reseller-${suffix}`]
  );
  orgA = a.rows[0].id;
  const b = await admin.query(
    "INSERT INTO organizations (name, slug, org_role, parent_reseller_id) VALUES ($1, $2, 'customer', $3) RETURNING id",
    [`Platform Analytics Customer ${suffix}`, `platform-analytics-customer-${suffix}`, orgA]
  );
  orgB = b.rows[0].id;
  const c = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Platform Analytics Unrelated ${suffix}`,
    `platform-analytics-unrelated-${suffix}`,
  ]);
  orgC = c.rows[0].id;

  // orgB: 1 completed call (60s), cost_records amount=1, billed=2.
  await admin.query(
    `INSERT INTO calls (org_id, direction, status, duration_seconds) VALUES ($1, 'outbound', 'completed', 60)`,
    [orgB]
  );
  await admin.query(`INSERT INTO cost_records (org_id, amount_usd, billed_amount) VALUES ($1, 1, 2)`, [orgB]);

  // orgC (unrelated to orgA): 1 completed call (60s), cost_records amount=5, billed=10.
  await admin.query(
    `INSERT INTO calls (org_id, direction, status, duration_seconds) VALUES ($1, 'outbound', 'completed', 60)`,
    [orgC]
  );
  await admin.query(`INSERT INTO cost_records (org_id, amount_usd, billed_amount) VALUES ($1, 5, 10)`, [orgC]);
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = ANY($1)", [[orgB, orgC, orgA]]);
  await admin.end();
});

describe("platform + reseller analytics", () => {
  it("platform_analytics_summary sums across every tenant", async () => {
    const summary = await withoutTenant((client) => loadPlatformAnalyticsSummary(client));
    // At least the fixture rows from orgB and orgC must be reflected —
    // other tests in this suite may add their own orgs concurrently, so
    // assert lower bounds rather than exact totals for the cross-suite-safe
    // parts, but exact for cost since only this test added cost_records
    // for these specific orgs (isolated by org id, summed platform-wide).
    expect(summary.totalAiCostUsd).toBeGreaterThanOrEqual(6); // >= 1 + 5 from this test's fixtures
    expect(summary.totalRevenue).toBeGreaterThanOrEqual(12); // >= 2 + 10
    expect(summary.totalTenants).toBeGreaterThanOrEqual(3);
  });

  it("reseller_analytics_summary includes only the reseller's own + customer orgs, not unrelated orgs", async () => {
    const summary = await withoutTenant((client) => loadResellerAnalyticsSummary(client, orgA));

    expect(summary.totalTenants).toBe(2); // orgA itself + orgB
    expect(summary.callsToday).toBe(1); // orgB's call only, not orgC's
    expect(summary.totalAiCostUsd).toBeCloseTo(1, 5); // orgB's cost only
    expect(summary.totalRevenue).toBeCloseTo(2, 5);
  });
});
