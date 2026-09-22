import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

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
      <div>
        <PageHeader title="Customers" />
        <div className="card">
          <p className="error">This page is only available to reseller accounts.</p>
        </div>
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
    <div>
      <PageHeader
        title="Customers"
        description="Orgs you resell this platform to — billed through you from the moment they're created."
      />
      <div className="card">
        {customers.length === 0 ? (
          <EmptyState title="No customers yet" description="Customer orgs you create will appear here, billed through your reseller account." />
        ) : (
          <div className="table-wrap">
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
          </div>
        )}
      </div>
    </div>
  );
}
