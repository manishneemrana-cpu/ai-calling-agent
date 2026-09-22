import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * /dashboard/admin/resellers — platform-owner-only, full visibility across
 * every reseller (including REAL platform cost, per the spec: "Platform
 * owner sees everything"). Backed by `platform_list_resellers()`
 * (db/migrations/013_phase8_reseller_hierarchy.sql), a SECURITY DEFINER
 * function that itself re-checks `current_org_role() = 'platform'` before
 * returning anything — this page's own role check below is a UX
 * convenience, not the security boundary; even a direct call to that
 * function from a non-platform org's connection raises an exception.
 */
export default async function AdminResellersPage() {
  const session = await getSession();
  if (!session) return null;

  if (session.orgRole !== "platform") {
    return (
      <div>
        <PageHeader title="Resellers" />
        <div className="card">
          <p className="error">Platform-owner only.</p>
        </div>
      </div>
    );
  }

  const { rows, error } = await withTenant(session.orgId, session.userId, async (client) => {
    try {
      const { rows } = await client.query(`SELECT * FROM platform_list_resellers()`);
      return { rows, error: null as string | null };
    } catch (e) {
      return { rows: [], error: e instanceof Error ? e.message : "Failed to load resellers" };
    }
  });

  return (
    <div>
      <PageHeader
        title="Resellers"
        description="Every reseller: customer count, configured buy/sell rates, and real aggregated platform cost."
      />
      <div className="card">
        {error && <p className="error">{error}</p>}
        {rows.length === 0 ? (
          <EmptyState title="No resellers yet" description="Promote an org to reseller via promote_org_role() to see it here." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reseller</th>
                  <th>Company name</th>
                  <th>Customers</th>
                  <th>Buy rate (USD/min)</th>
                  <th>Sell rate (USD/min)</th>
                  <th>Real platform cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.reseller_org_id}>
                    <td>{r.reseller_name}</td>
                    <td>{r.company_name ?? "—"}</td>
                    <td>{r.customer_count}</td>
                    <td>{r.buy_price_per_minute_usd !== null ? `$${Number(r.buy_price_per_minute_usd).toFixed(6)}` : "not set"}</td>
                    <td>{r.sell_price_per_minute_usd !== null ? `$${Number(r.sell_price_per_minute_usd).toFixed(6)}` : "not set"}</td>
                    <td>${Number(r.real_platform_cost_usd).toFixed(4)}</td>
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
