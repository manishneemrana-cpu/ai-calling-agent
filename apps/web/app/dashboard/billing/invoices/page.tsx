import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";

/**
 * /dashboard/billing/invoices — plumbing-proof invoice list (plain HTML
 * table, no PDF — PDF rendering is deferred to a later phase per the
 * Phase 7 spec's own scoping note). Each invoice already carries its
 * TENANT's own configured issuing_entity_name (see
 * lib/billing/invoices.ts's generateInvoice()), never a hardcoded company
 * name.
 */
export default async function InvoicesPage() {
  const session = await getSession();
  if (!session) return null;

  const invoices = await withTenant(session.orgId, session.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, invoice_number, issuing_entity_name, period_start, period_end,
              subtotal, gst_amount, total_amount, status, issued_at
         FROM invoices WHERE org_id = $1 ORDER BY created_at DESC`,
      [session.orgId]
    );
    return rows;
  });

  return (
    <div className="card">
      <h1>Invoices</h1>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Structured invoice records generated from this org&apos;s cost/usage aggregates (see
        lib/billing/invoices.ts). PDF rendering is deferred to a later phase — this table is the Phase 7 bar.
      </p>
      {invoices.length === 0 ? (
        <p className="empty-state">No invoices yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Issuing entity</th>
              <th>Period</th>
              <th>Subtotal</th>
              <th>GST</th>
              <th>Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <td>{inv.invoice_number}</td>
                <td>{inv.issuing_entity_name}</td>
                <td>
                  {new Date(inv.period_start).toLocaleDateString()} – {new Date(inv.period_end).toLocaleDateString()}
                </td>
                <td>{Number(inv.subtotal).toFixed(2)}</td>
                <td>{Number(inv.gst_amount).toFixed(2)}</td>
                <td>{Number(inv.total_amount).toFixed(2)}</td>
                <td>{inv.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
