import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { generateInvoice } from "@/lib/billing/invoices";

/**
 * Proves invoice generation: aggregates a known org's cost_records over a
 * period into invoice_line_items, computes GST correctly, and — the
 * multi-industry non-negotiable — uses the TENANT's configured
 * issuing_entity_name, never a hardcoded platform/founder company name.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Invoice Test Org ${suffix}`,
    `invoice-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;
  await admin.query(
    `INSERT INTO billing_accounts (org_id, issuing_entity_name, gstin) VALUES ($1, 'Acme Diagnostics Pvt Ltd', '27AAAAA0000A1Z5')`,
    [orgId]
  );

  // Two usage/cost rows inside the invoicing period.
  const u1 = await admin.query(
    `INSERT INTO usage_records (org_id, provider_type, provider_key, quantity, unit, recorded_at)
     VALUES ($1, 'telephony', 'mock', 100, 'seconds', '2026-08-15') RETURNING id`,
    [orgId]
  );
  await admin.query(
    `INSERT INTO cost_records (org_id, usage_record_id, amount_usd, billed_amount, recorded_at) VALUES ($1, $2, 1.0, 2.0, '2026-08-15')`,
    [orgId, u1.rows[0].id]
  );
  const u2 = await admin.query(
    `INSERT INTO usage_records (org_id, provider_type, provider_key, quantity, unit, recorded_at)
     VALUES ($1, 'stt', 'mock', 200, 'seconds', '2026-08-20') RETURNING id`,
    [orgId]
  );
  await admin.query(
    `INSERT INTO cost_records (org_id, usage_record_id, amount_usd, recorded_at) VALUES ($1, $2, 3.0, '2026-08-20')`,
    [orgId, u2.rows[0].id]
  );
  // Outside the period — must be excluded.
  const u3 = await admin.query(
    `INSERT INTO usage_records (org_id, provider_type, provider_key, quantity, unit, recorded_at)
     VALUES ($1, 'telephony', 'mock', 999, 'seconds', '2026-09-15') RETURNING id`,
    [orgId]
  );
  await admin.query(
    `INSERT INTO cost_records (org_id, usage_record_id, amount_usd, recorded_at) VALUES ($1, $2, 999.0, '2026-09-15')`,
    [orgId, u3.rows[0].id]
  );
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

describe("generateInvoice", () => {
  it("aggregates only in-period line items, uses billed_amount when set, and uses the tenant's own issuing_entity_name", async () => {
    const invoice = await generateInvoice({
      orgId,
      userId: null,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      gstRatePercent: 18,
    });

    // telephony line uses billed_amount ($2.00), stt line has no
    // billed_amount so falls back to amount_usd ($3.00). September's
    // $999 row must be excluded entirely.
    expect(invoice.subtotal).toBeCloseTo(5.0, 6);
    expect(invoice.gstAmount).toBeCloseTo(0.9, 6); // 18% of 5.00
    expect(invoice.totalAmount).toBeCloseTo(5.9, 6);
    expect(invoice.issuingEntityName).toBe("Acme Diagnostics Pvt Ltd");
    expect(invoice.issuingEntityName).not.toMatch(/SitesNSign/i);
    expect(invoice.lineItems).toHaveLength(2);

    const { rows: lineRows } = await admin.query(
      `SELECT count(*)::int AS c FROM invoice_line_items WHERE invoice_id = $1`,
      [invoice.invoiceId]
    );
    expect(lineRows[0].c).toBe(2);

    const { rows: invoiceRows } = await admin.query(`SELECT status, issuing_entity_name FROM invoices WHERE id = $1`, [
      invoice.invoiceId,
    ]);
    expect(invoiceRows[0].status).toBe("issued");
    expect(invoiceRows[0].issuing_entity_name).toBe("Acme Diagnostics Pvt Ltd");
  });
});
