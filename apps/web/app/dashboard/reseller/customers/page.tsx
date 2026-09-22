import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";

/**
 * /dashboard/reseller/customers — a reseller's own customer orgs. Visible
 * only to a reseller-role org (session.orgRole === "reseller"); RLS itself
 * also only ever returns orgs with parent_reseller_id = current_org_id()
 * because this query runs inside withTenant scoped to the reseller's own
 * org id — a reseller can never widen this to another reseller's customers.
 */
export default async function ResellerCustomersPage() {
  const session = await getSession();
  if (!session) return null;

  if (session.orgRole !== "reseller") {
    return (
      <div className="card">
        <h1>Customers</h1>
        <p className="error">This page is only available to reseller accounts.</p>
      </div>
    );
  }

  const customers = await withTenant(session.orgId, session.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, name, slug, tier, created_at FROM organizations
        WHERE parent_reseller_id = $1 ORDER BY created_at DESC`,
      [session.orgId]
    );
    return rows;
  });

  return (
    <div className="card">
      <h1>Customers</h1>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Orgs you resell this platform to. Created via <code>create_customer_org()</code> (see
        db/migrations/013_phase8_reseller_hierarchy.sql), which stamps each one&apos;s{" "}
        <code>parent_reseller_id</code> to you and wires their <code>billing_accounts.reseller_id</code> so
        they&apos;re billed through you from the moment they exist.
      </p>
      {customers.length === 0 ? (
        <p className="empty-state">No customers yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Tier</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.slug}</td>
                <td>{c.tier}</td>
                <td>{new Date(c.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
