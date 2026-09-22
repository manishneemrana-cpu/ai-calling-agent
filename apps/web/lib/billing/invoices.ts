import { withTenant } from "../db/tenant";

/**
 * Invoice generation (Phase 7) — given a billing period, aggregates an
 * org's usage/cost into `invoice_line_items` and produces an `invoices`
 * row with GST fields and the TENANT's own configured
 * `issuing_entity_name` (read from `billing_accounts` — never a hardcoded
 * company name; see the grep-for-"SitesNSign" check in the Phase 7
 * report).
 *
 * Customer-facing amount per line: `cost_records.billed_amount` when set
 * (the column Phase 1 reserved for exactly this — "what we charge the
 * tenant, may include markup" — db/migrations/004_billing_providers.sql),
 * falling back to the raw platform cost (`amount_usd`) only when no
 * markup has been configured for that record, so a tenant is never
 * charged less than $0 of actual spend by omission. Rendering an actual
 * PDF is deferred to a later phase (see report) — this produces a
 * structured record only.
 */

export type GenerateInvoiceParams = {
  orgId: string;
  userId: string | null;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  gstRatePercent?: number;
};

export async function generateInvoice(params: GenerateInvoiceParams) {
  return withTenant(params.orgId, params.userId, async (client) => {
    const accountRow = await client.query(
      `SELECT issuing_entity_name, gstin FROM billing_accounts WHERE org_id = $1`,
      [params.orgId]
    );
    const issuingEntityName = accountRow.rows[0]?.issuing_entity_name ?? "Your Company";
    const issuingGstin = accountRow.rows[0]?.gstin ?? null;

    const orgRow = await client.query(`SELECT name FROM organizations WHERE id = $1`, [params.orgId]);
    const billedToName = orgRow.rows[0]?.name ?? "Customer";

    const lineRows = await client.query(
      `SELECT ur.provider_type AS unit_group, ur.unit,
              SUM(ur.quantity) AS quantity,
              SUM(COALESCE(cr.billed_amount, cr.amount_usd)) AS line_total
         FROM cost_records cr
         JOIN usage_records ur ON ur.id = cr.usage_record_id
        WHERE cr.org_id = $1 AND cr.recorded_at >= $2 AND cr.recorded_at < $3::date + interval '1 day'
        GROUP BY ur.provider_type, ur.unit
        ORDER BY ur.provider_type`,
      [params.orgId, params.periodStart, params.periodEnd]
    );

    const lineItems = lineRows.rows.map((r) => {
      const quantity = Number(r.quantity);
      const lineTotal = Number(r.line_total);
      return {
        description: `${r.unit_group} usage`,
        quantity,
        unit: r.unit,
        unitPrice: quantity === 0 ? 0 : lineTotal / quantity,
        lineTotal,
      };
    });

    const subtotal = lineItems.reduce((sum, li) => sum + li.lineTotal, 0);
    const gstRatePercent = params.gstRatePercent ?? 18;
    const gstAmount = round2((subtotal * gstRatePercent) / 100);
    const totalAmount = round2(subtotal + gstAmount);

    const invoiceNumber = `INV-${params.periodStart.replace(/-/g, "")}-${Date.now().toString(36).toUpperCase()}`;

    const invoiceRow = await client.query(
      `INSERT INTO invoices
         (org_id, invoice_number, issuing_entity_name, issuing_entity_gstin, billed_to_name,
          period_start, period_end, subtotal, gst_rate_percent, gst_amount, total_amount, status, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'issued', now())
       RETURNING id, invoice_number`,
      [
        params.orgId,
        invoiceNumber,
        issuingEntityName,
        issuingGstin,
        billedToName,
        params.periodStart,
        params.periodEnd,
        round2(subtotal),
        gstRatePercent,
        gstAmount,
        totalAmount,
      ]
    );
    const invoiceId = invoiceRow.rows[0].id;

    for (const li of lineItems) {
      await client.query(
        `INSERT INTO invoice_line_items (org_id, invoice_id, description, quantity, unit, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [params.orgId, invoiceId, li.description, li.quantity, li.unit, li.unitPrice, li.lineTotal]
      );
    }

    return {
      invoiceId,
      invoiceNumber: invoiceRow.rows[0].invoice_number,
      issuingEntityName,
      subtotal: round2(subtotal),
      gstAmount,
      totalAmount,
      lineItems,
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
