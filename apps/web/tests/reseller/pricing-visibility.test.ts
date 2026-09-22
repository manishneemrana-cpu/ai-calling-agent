import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";

/**
 * The Phase 8 cross-tier data-leakage proof — the most important
 * correctness property in this phase (per the spec). Attacks the rule from
 * multiple angles, at the DB layer, same methodology as
 * apps/web/tests/billing/tenant-isolation-billing.test.ts:
 *
 *   1. A reseller's connection must NEVER see platform_rate_cards (raw
 *      platform vendor cost).
 *   2. A reseller's connection must NEVER be able to call
 *      platform-owner-only functions (platform_list_resellers,
 *      set_reseller_buy_rate) — not even to set/read its OWN buy rate.
 *   3. A customer's connection must NEVER see its reseller's buy/sell rate
 *      rows (cost/margin), even by org_id directly.
 *   4. Control cases: the reseller CAN read its own buy/sell rates; the
 *      platform owner CAN read provider_rate_cards and call the
 *      platform-only functions. Proves the rule blocks the right
 *      direction, not everything.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";
const APP_URL =
  process.env.DATABASE_URL ?? "postgresql://app_user:app_user_dev_password@localhost:5432/ai_calling_agent";

let admin: Client;
let platformOrgId: string;
let resellerOrgId: string;
let customerOrgId: string;
let otherResellerOrgId: string;

async function asTenant<T>(orgId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [""]);
    // Mirror apps/web/lib/db/tenant.ts's withTenant(): derive org_role from
    // the DB itself, exactly as the app does, rather than trusting a value
    // supplied by the test.
    const { rows } = await client.query("SELECT org_role FROM organizations WHERE id = current_org_id()");
    await client.query("SELECT set_config('app.current_org_role', $1, true)", [rows[0]?.org_role ?? ""]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);

  const platformRow = await admin.query(
    "INSERT INTO organizations (name, slug, org_role) VALUES ($1, $2, 'platform') RETURNING id",
    [`Platform Owner ${suffix}`, `platform-owner-${suffix}`]
  );
  platformOrgId = platformRow.rows[0].id;

  const resellerRow = await admin.query(
    "INSERT INTO organizations (name, slug, org_role, parent_reseller_id) VALUES ($1, $2, 'reseller', $3) RETURNING id",
    [`Reseller Org ${suffix}`, `reseller-org-${suffix}`, platformOrgId]
  );
  resellerOrgId = resellerRow.rows[0].id;

  const otherResellerRow = await admin.query(
    "INSERT INTO organizations (name, slug, org_role, parent_reseller_id) VALUES ($1, $2, 'reseller', $3) RETURNING id",
    [`Other Reseller Org ${suffix}`, `other-reseller-org-${suffix}`, platformOrgId]
  );
  otherResellerOrgId = otherResellerRow.rows[0].id;

  const customerRow = await admin.query(
    "INSERT INTO organizations (name, slug, org_role, parent_reseller_id) VALUES ($1, $2, 'customer', $3) RETURNING id",
    [`Customer Org ${suffix}`, `customer-org-${suffix}`, resellerOrgId]
  );
  customerOrgId = customerRow.rows[0].id;

  // Give the reseller a real buy rate (platform-set) and sell rate
  // (reseller-set), so there's something to prove is/isn't visible.
  await admin.query(
    `INSERT INTO reseller_buy_rates (org_id, buy_price_per_minute_usd) VALUES ($1, 0.0025)`,
    [resellerOrgId]
  );
  await admin.query(
    `INSERT INTO reseller_sell_rates (org_id, sell_price_per_minute_usd) VALUES ($1, 0.02)`,
    [resellerOrgId]
  );

  // Real platform rate card row must already exist from earlier migrations
  // (mock/frejun_teler/etc, see 012_phase7_billing.sql) — nothing to insert.
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = ANY($1)", [
    [customerOrgId, resellerOrgId, otherResellerOrgId, platformOrgId],
  ]);
  await admin.end();
});

describe("Phase 8 — a reseller must NEVER see platform cost", () => {
  it("a reseller's connection reading provider_rate_cards directly gets ZERO rows", async () => {
    const rows = await asTenant(resellerOrgId, async (c) => {
      const { rows } = await c.query("SELECT * FROM provider_rate_cards");
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("a reseller's connection cannot call platform_list_resellers() (raises)", async () => {
    await expect(
      asTenant(resellerOrgId, async (c) => {
        await c.query("SELECT * FROM platform_list_resellers()");
      })
    ).rejects.toThrow(/platform-owner only/i);
  });

  it("a reseller's connection cannot set its OWN buy rate via set_reseller_buy_rate()", async () => {
    await expect(
      asTenant(resellerOrgId, async (c) => {
        await c.query("SELECT set_reseller_buy_rate($1, $2)", [resellerOrgId, 0.0001]);
      })
    ).rejects.toThrow(/only the platform owner/i);
  });

  it("a reseller's connection cannot INSERT/UPDATE reseller_buy_rates directly (no grant)", async () => {
    await expect(
      asTenant(resellerOrgId, async (c) => {
        await c.query(
          `UPDATE reseller_buy_rates SET buy_price_per_minute_usd = 0.0001 WHERE org_id = $1`,
          [resellerOrgId]
        );
      })
    ).rejects.toThrow();
  });

  it("a reseller's connection cannot read ANOTHER reseller's buy/sell rates", async () => {
    await admin.query(
      `INSERT INTO reseller_buy_rates (org_id, buy_price_per_minute_usd) VALUES ($1, 0.0099) ON CONFLICT DO NOTHING`,
      [otherResellerOrgId]
    );
    const rows = await asTenant(resellerOrgId, async (c) => {
      const { rows } = await c.query("SELECT * FROM reseller_buy_rates WHERE org_id = $1", [otherResellerOrgId]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("Phase 8 — a reseller's customer must NEVER see the reseller's cost/margin", () => {
  it("a customer's connection reading its reseller's reseller_buy_rates row gets ZERO rows", async () => {
    const rows = await asTenant(customerOrgId, async (c) => {
      const { rows } = await c.query("SELECT * FROM reseller_buy_rates WHERE org_id = $1", [resellerOrgId]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("a customer's connection reading its reseller's reseller_sell_rates row gets ZERO rows", async () => {
    const rows = await asTenant(customerOrgId, async (c) => {
      const { rows } = await c.query("SELECT * FROM reseller_sell_rates WHERE org_id = $1", [resellerOrgId]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("a customer's connection reading provider_rate_cards also gets ZERO rows", async () => {
    const rows = await asTenant(customerOrgId, async (c) => {
      const { rows } = await c.query("SELECT * FROM provider_rate_cards");
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("a customer's connection cannot call platform_list_resellers()", async () => {
    await expect(
      asTenant(customerOrgId, async (c) => {
        await c.query("SELECT * FROM platform_list_resellers()");
      })
    ).rejects.toThrow(/platform-owner only/i);
  });
});

describe("Phase 8 — control cases: the rule blocks the right direction, not everything", () => {
  it("a reseller CAN read its own reseller_buy_rates row", async () => {
    const rows = await asTenant(resellerOrgId, async (c) => {
      const { rows } = await c.query("SELECT buy_price_per_minute_usd FROM reseller_buy_rates WHERE org_id = $1", [
        resellerOrgId,
      ]);
      return rows;
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].buy_price_per_minute_usd)).toBeCloseTo(0.0025, 6);
  });

  it("a reseller CAN read and update its own reseller_sell_rates row", async () => {
    await asTenant(resellerOrgId, async (c) => {
      await c.query(
        `UPDATE reseller_sell_rates SET sell_price_per_minute_usd = 0.03 WHERE org_id = $1`,
        [resellerOrgId]
      );
    });
    const rows = await asTenant(resellerOrgId, async (c) => {
      const { rows } = await c.query("SELECT sell_price_per_minute_usd FROM reseller_sell_rates WHERE org_id = $1", [
        resellerOrgId,
      ]);
      return rows;
    });
    expect(Number(rows[0].sell_price_per_minute_usd)).toBeCloseTo(0.03, 6);
  });

  it("the platform owner CAN read provider_rate_cards", async () => {
    const rows = await asTenant(platformOrgId, async (c) => {
      const { rows } = await c.query("SELECT * FROM provider_rate_cards LIMIT 1");
      return rows;
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("the platform owner CAN call platform_list_resellers() and see the reseller's real numbers", async () => {
    const rows = await asTenant(platformOrgId, async (c) => {
      const { rows } = await c.query("SELECT * FROM platform_list_resellers() WHERE reseller_org_id = $1", [
        resellerOrgId,
      ]);
      return rows;
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].buy_price_per_minute_usd)).toBeCloseTo(0.0025, 6);
  });

  it("the platform owner CAN set a reseller's buy rate via set_reseller_buy_rate()", async () => {
    await asTenant(platformOrgId, async (c) => {
      await c.query("SELECT set_reseller_buy_rate($1, $2, $3, $4)", [
        resellerOrgId,
        0.003,
        "USD",
        "founder@example.com",
      ]);
    });
    const rows = await asTenant(resellerOrgId, async (c) => {
      const { rows } = await c.query("SELECT buy_price_per_minute_usd FROM reseller_buy_rates WHERE org_id = $1", [
        resellerOrgId,
      ]);
      return rows;
    });
    expect(Number(rows[0].buy_price_per_minute_usd)).toBeCloseTo(0.003, 6);
  });
});
