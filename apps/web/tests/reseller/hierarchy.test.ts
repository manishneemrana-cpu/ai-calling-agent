import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";

/**
 * Proves the hierarchy-creation functions (promote_org_role,
 * create_customer_org) actually do what docs/RESELLER_HIERARCHY.md claims:
 * only a platform owner can promote an org to reseller; only a reseller can
 * create a customer org under itself, and that customer is atomically
 * wired to Phase 7's billing_accounts.reseller_id.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";
const APP_URL =
  process.env.DATABASE_URL ?? "postgresql://app_user:app_user_dev_password@localhost:5432/ai_calling_agent";

let admin: Client;
let platformOrgId: string;
let plainCustomerOrgId: string;

async function asTenant<T>(orgId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [""]);
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
    [`Hierarchy Platform ${suffix}`, `hierarchy-platform-${suffix}`]
  );
  platformOrgId = platformRow.rows[0].id;

  const customerRow = await admin.query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    [`Hierarchy Plain Customer ${suffix}`, `hierarchy-plain-customer-${suffix}`]
  );
  plainCustomerOrgId = customerRow.rows[0].id; // default org_role='customer'
});

afterAll(async () => {
  await admin.query(`DELETE FROM organizations WHERE parent_reseller_id = ANY($1) OR id = ANY($1)`, [
    [platformOrgId, plainCustomerOrgId],
  ]);
  await admin.end();
});

describe("promote_org_role", () => {
  it("a non-platform org cannot promote another org to reseller", async () => {
    await expect(
      asTenant(plainCustomerOrgId, async (c) => {
        await c.query("SELECT promote_org_role($1, 'reseller')", [plainCustomerOrgId]);
      })
    ).rejects.toThrow(/only the platform owner/i);
  });

  it("the platform owner CAN promote an org to reseller", async () => {
    await asTenant(platformOrgId, async (c) => {
      await c.query("SELECT promote_org_role($1, 'reseller', $2)", [plainCustomerOrgId, platformOrgId]);
    });
    const { rows } = await admin.query("SELECT org_role, parent_reseller_id FROM organizations WHERE id = $1", [
      plainCustomerOrgId,
    ]);
    expect(rows[0].org_role).toBe("reseller");
    expect(rows[0].parent_reseller_id).toBe(platformOrgId);
  });
});

describe("create_customer_org", () => {
  it("a non-reseller org cannot create a customer org", async () => {
    await expect(
      asTenant(platformOrgId, async (c) => {
        await c.query("SELECT * FROM create_customer_org($1, $2, $3, $4, $5)", [
          "Should Fail Co",
          `should-fail-${randomUUID().slice(0, 8)}`,
          "shouldfail@example.com",
          "not-a-real-hash",
          "Nobody",
        ]);
      })
    ).rejects.toThrow(/caller must be a reseller/i);
  });

  it("a reseller CAN create a customer org, atomically wired to billing_accounts.reseller_id", async () => {
    // plainCustomerOrgId was promoted to reseller above.
    const suffix = randomUUID().slice(0, 8);
    const { orgId: newCustomerOrgId } = await asTenant(plainCustomerOrgId, async (c) => {
      const { rows } = await c.query("SELECT * FROM create_customer_org($1, $2, $3, $4, $5)", [
        `Resold Customer ${suffix}`,
        `resold-customer-${suffix}`,
        `resold-${suffix}@example.com`,
        "not-a-real-hash",
        "Resold Owner",
      ]);
      return { orgId: rows[0].org_id as string };
    });

    const orgRow = await admin.query("SELECT org_role, parent_reseller_id FROM organizations WHERE id = $1", [
      newCustomerOrgId,
    ]);
    expect(orgRow.rows[0].org_role).toBe("customer");
    expect(orgRow.rows[0].parent_reseller_id).toBe(plainCustomerOrgId);

    const billingRow = await admin.query(
      "SELECT reseller_id, billing_mode FROM billing_accounts WHERE org_id = $1",
      [newCustomerOrgId]
    );
    expect(billingRow.rows[0].reseller_id).toBe(plainCustomerOrgId);
    expect(billingRow.rows[0].billing_mode).toBe("reseller_managed");

    await admin.query("DELETE FROM organizations WHERE id = $1", [newCustomerOrgId]);
  });
});
