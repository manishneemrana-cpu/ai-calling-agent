import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";

/**
 * Extends the tenant-isolation proof (apps/web/tests/tenant-isolation.test.ts)
 * to every Phase 7 table: wallets, wallet_transactions, billing_accounts,
 * invoices. Same methodology — connect as app_user, prove org B cannot
 * read/write org A's rows even when asking by id directly.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";
const APP_URL =
  process.env.DATABASE_URL ?? "postgresql://app_user:app_user_dev_password@localhost:5432/ai_calling_agent";

let admin: Client;
let orgA: string;
let orgB: string;
let walletA: string;
let invoiceA: string;

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

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgAResult = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Billing Isolation Org A ${suffix}`,
    `billing-isolation-org-a-${suffix}`,
  ]);
  orgA = orgAResult.rows[0].id;
  const orgBResult = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Billing Isolation Org B ${suffix}`,
    `billing-isolation-org-b-${suffix}`,
  ]);
  orgB = orgBResult.rows[0].id;

  const walletRow = await admin.query(
    `INSERT INTO wallets (org_id, balance) VALUES ($1, 500) RETURNING id`,
    [orgA]
  );
  walletA = walletRow.rows[0].id;
  await admin.query(
    `INSERT INTO billing_accounts (org_id, issuing_entity_name) VALUES ($1, 'Org A Legal Entity')`,
    [orgA]
  );
  const invoiceRow = await admin.query(
    `INSERT INTO invoices (org_id, invoice_number, issuing_entity_name, billed_to_name, period_start, period_end, total_amount)
     VALUES ($1, 'INV-TEST-1', 'Org A Legal Entity', 'Org A', '2026-08-01', '2026-08-31', 100) RETURNING id`,
    [orgA]
  );
  invoiceA = invoiceRow.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = ANY($1)", [[orgA, orgB]]);
  await admin.end();
});

describe("tenant isolation — Phase 7 billing tables", () => {
  it("org B cannot read org A's wallet, even by id directly", async () => {
    const rows = await asTenant(orgB, async (c) => {
      const { rows } = await c.query("SELECT * FROM wallets WHERE id = $1", [walletA]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("org B cannot read org A's billing_accounts row", async () => {
    const rows = await asTenant(orgB, async (c) => {
      const { rows } = await c.query("SELECT * FROM billing_accounts WHERE org_id = $1", [orgA]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("org B cannot read org A's invoice", async () => {
    const rows = await asTenant(orgB, async (c) => {
      const { rows } = await c.query("SELECT * FROM invoices WHERE id = $1", [invoiceA]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("org B cannot debit org A's wallet by inserting a wallet_transactions row against it", async () => {
    await expect(
      asTenant(orgB, async (c) => {
        await c.query(
          `INSERT INTO wallet_transactions (org_id, wallet_id, type, reason, amount, balance_after)
           VALUES ($1, $2, 'debit', 'adjustment', 1, 499)`,
          [orgA, walletA]
        );
      })
    ).rejects.toThrow();
  });

  it("org A can still read its own wallet normally", async () => {
    const rows = await asTenant(orgA, async (c) => {
      const { rows } = await c.query("SELECT balance FROM wallets WHERE id = $1", [walletA]);
      return rows;
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].balance)).toBe(500);
  });
});
