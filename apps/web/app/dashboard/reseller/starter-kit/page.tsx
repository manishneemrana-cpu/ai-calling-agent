import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import { createStarterKitShareAction } from "../actions";

/**
 * /dashboard/reseller/starter-kit — the Reseller Starter Kit's in-app home
 * (section 4 of the Phase 8 spec). The demo-mode sales script and proposal
 * template are content deliverables, kept as markdown under
 * docs/RESELLER_STARTER_KIT/ (see that directory's own note on why) — this
 * page is the cost-simulator EXPORT mechanism: create a shareable snapshot
 * link (and a CSV) computed only from this reseller's own buy/sell numbers.
 */
export default async function ResellerStarterKitPage() {
  const session = await getSession();
  if (!session) return null;
  if (session.orgRole !== "reseller") {
    return (
      <div className="card">
        <h1>Reseller Starter Kit</h1>
        <p className="error">This page is only available to reseller accounts.</p>
      </div>
    );
  }

  const shares = await withTenant(session.orgId, session.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, share_token, prospect_name, plan_label, estimated_minutes_per_month, created_at
         FROM reseller_starter_kit_shares WHERE reseller_org_id = $1 ORDER BY created_at DESC`,
      [session.orgId]
    );
    return rows;
  });

  return (
    <div className="card">
      <h1>Reseller Starter Kit</h1>
      <ul style={{ marginBottom: "1.5rem" }}>
        <li>
          Sales script (demo-mode walkthrough): <code>docs/RESELLER_STARTER_KIT/SALES_SCRIPT.md</code>
        </li>
        <li>
          Proposal template: <code>docs/RESELLER_STARTER_KIT/PROPOSAL_TEMPLATE.md</code>
        </li>
        <li>
          Cost-simulator export: create a shareable link below, or download it as CSV.
        </li>
      </ul>

      <h2>Create a cost-simulator share for a prospect</h2>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Computed only from YOUR buy/sell rates — never the platform&apos;s underlying vendor rate cards. The
        link works without the prospect logging in.
      </p>
      <form action={createStarterKitShareAction}>
        <label>
          Prospect name
          <input type="text" name="prospectName" />
        </label>
        <label>
          Plan label
          <input type="text" name="planLabel" placeholder="e.g. Starter — 2,000 min/mo" />
        </label>
        <label>
          Estimated minutes/month
          <input type="number" name="estimatedMinutesPerMonth" min="1" step="1" required />
        </label>
        <button type="submit">Create share link</button>
      </form>

      <h2 style={{ marginTop: "2rem" }}>Existing shares</h2>
      {shares.length === 0 ? (
        <p className="empty-state">No shares created yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Prospect</th>
              <th>Plan</th>
              <th>Est. minutes/mo</th>
              <th>Link</th>
              <th>CSV</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {shares.map((s) => (
              <tr key={s.id}>
                <td>{s.prospect_name ?? "—"}</td>
                <td>{s.plan_label ?? "—"}</td>
                <td>{Number(s.estimated_minutes_per_month).toLocaleString()}</td>
                <td>
                  <a href={`/starter-kit/${s.share_token}`}>/starter-kit/{s.share_token}</a>
                </td>
                <td>
                  <a href={`/api/reseller/starter-kit/export?token=${s.share_token}`}>Download CSV</a>
                </td>
                <td>{new Date(s.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
