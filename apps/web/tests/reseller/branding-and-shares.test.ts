import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";

/**
 * Proves: (1) reseller_branding is tenant-isolated like every other table
 * (2) the pre-auth domain-routing lookup (resolve_reseller_branding_by_host)
 * works without any session/org context and returns ONLY branding fields
 * (3) a starter-kit share snapshot is readable by token with no auth, and
 * is a frozen snapshot (never a live join back to current rates).
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";
const APP_URL =
  process.env.DATABASE_URL ?? "postgresql://app_user:app_user_dev_password@localhost:5432/ai_calling_agent";

let admin: Client;
let resellerOrgId: string;
let otherOrgId: string;
let subdomain: string;

async function asTenant<T>(orgId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [""]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

async function withoutTenant<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: APP_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  subdomain = `acme-${suffix}`;

  const resellerRow = await admin.query(
    "INSERT INTO organizations (name, slug, org_role) VALUES ($1, $2, 'reseller') RETURNING id",
    [`Branding Reseller ${suffix}`, `branding-reseller-${suffix}`]
  );
  resellerOrgId = resellerRow.rows[0].id;

  const otherRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Branding Other Org ${suffix}`,
    `branding-other-org-${suffix}`,
  ]);
  otherOrgId = otherRow.rows[0].id;

  await admin.query(
    `INSERT INTO reseller_branding (org_id, company_name, subdomain, support_email)
     VALUES ($1, 'Acme Voice', $2, 'support@acme.example')`,
    [resellerOrgId, subdomain]
  );
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = ANY($1)", [[resellerOrgId, otherOrgId]]);
  await admin.end();
});

describe("reseller_branding — tenant isolation", () => {
  it("another org cannot read the reseller's branding row directly", async () => {
    const rows = await asTenant(otherOrgId, async (c) => {
      const { rows } = await c.query("SELECT * FROM reseller_branding WHERE org_id = $1", [resellerOrgId]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("the reseller can read its own branding row", async () => {
    const rows = await asTenant(resellerOrgId, async (c) => {
      const { rows } = await c.query("SELECT company_name FROM reseller_branding WHERE org_id = $1", [
        resellerOrgId,
      ]);
      return rows;
    });
    expect(rows[0].company_name).toBe("Acme Voice");
  });
});

describe("resolve_reseller_branding_by_host — pre-auth domain routing lookup", () => {
  it("resolves a subdomain with NO session/org context set", async () => {
    const rows = await withoutTenant(async (c) => {
      const { rows } = await c.query("SELECT * FROM resolve_reseller_branding_by_host($1, $2)", [subdomain, null]);
      return rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].company_name).toBe("Acme Voice");
    expect(rows[0].support_email).toBe("support@acme.example");
  });

  it("returns nothing for an unknown subdomain", async () => {
    const rows = await withoutTenant(async (c) => {
      const { rows } = await c.query("SELECT * FROM resolve_reseller_branding_by_host($1, $2)", [
        "nonexistent-slug-xyz",
        null,
      ]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("get_starter_kit_share — public token read is a frozen snapshot", () => {
  it("is readable with no session/org context, and reflects the snapshot even after rates change", async () => {
    await admin.query(
      `INSERT INTO reseller_buy_rates (org_id, buy_price_per_minute_usd) VALUES ($1, 0.002) ON CONFLICT (org_id) DO UPDATE SET buy_price_per_minute_usd = 0.002`,
      [resellerOrgId]
    );
    const token = randomUUID();
    await admin.query(
      `INSERT INTO reseller_starter_kit_shares
         (reseller_org_id, share_token, prospect_name, estimated_minutes_per_month, buy_price_per_minute_usd, sell_price_per_minute_usd)
       VALUES ($1, $2, 'Prospect Co', 2000, 0.002, 0.02)`,
      [resellerOrgId, token]
    );

    // Change the live buy rate AFTER the share was created.
    await admin.query(`UPDATE reseller_buy_rates SET buy_price_per_minute_usd = 0.009 WHERE org_id = $1`, [
      resellerOrgId,
    ]);

    const rows = await withoutTenant(async (c) => {
      const { rows } = await c.query("SELECT * FROM get_starter_kit_share($1)", [token]);
      return rows;
    });
    expect(rows).toHaveLength(1);
    // Snapshot value, NOT the updated live rate — proves it's frozen, not a live join.
    expect(Number(rows[0].buy_price_per_minute_usd)).toBeCloseTo(0.002, 6);
    expect(rows[0].prospect_name).toBe("Prospect Co");
  });

  it("returns nothing for an unknown token", async () => {
    const rows = await withoutTenant(async (c) => {
      const { rows } = await c.query("SELECT * FROM get_starter_kit_share($1)", [randomUUID()]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });
});
