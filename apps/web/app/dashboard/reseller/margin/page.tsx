import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import { getResellerBuyRate, getResellerSellRate, computeResellerMargin } from "@/lib/reseller/pricing";

/**
 * /dashboard/reseller/margin — a reseller's OWN margin view. Shows their own
 * buy cost (Y — what they pay, which per the spec's rule they ARE allowed
 * to see) vs their own sell price (Z) vs margin (Z - Y). NEVER the
 * platform's raw provider_rate_cards/vendor cost — that table is
 * platform-role-only at the RLS level (see
 * db/migrations/013_phase8_reseller_hierarchy.sql), so there is no query
 * this page could even run that would return it.
 */
export default async function ResellerMarginPage() {
  const session = await getSession();
  if (!session) return null;
  if (session.orgRole !== "reseller") {
    return (
      <div className="card">
        <h1>Margin</h1>
        <p className="error">This page is only available to reseller accounts.</p>
      </div>
    );
  }

  const margin = await withTenant(session.orgId, session.userId, async (client) => {
    const buy = await getResellerBuyRate(client, session.orgId);
    const sell = await getResellerSellRate(client, session.orgId);
    return computeResellerMargin(buy, sell);
  });

  return (
    <div className="card">
      <h1>Margin</h1>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Your own buy cost vs your own sell price. This is the ONLY cost figure a reseller can see on this
        platform — the platform&apos;s underlying vendor rate cards are never exposed here or anywhere else a
        reseller can query.
      </p>
      <table>
        <thead>
          <tr>
            <th>Your buy cost (USD/min)</th>
            <th>Your sell price (USD/min)</th>
            <th>Your margin (USD/min)</th>
            <th>Margin %</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{margin.buyPricePerMinuteUsd !== null ? `$${margin.buyPricePerMinuteUsd.toFixed(6)}` : "not set"}</td>
            <td>{margin.sellPricePerMinuteUsd !== null ? `$${margin.sellPricePerMinuteUsd.toFixed(6)}` : "not set"}</td>
            <td>{margin.marginPerMinuteUsd !== null ? `$${margin.marginPerMinuteUsd.toFixed(6)}` : "—"}</td>
            <td>{margin.marginPercent !== null ? `${margin.marginPercent.toFixed(1)}%` : "—"}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
