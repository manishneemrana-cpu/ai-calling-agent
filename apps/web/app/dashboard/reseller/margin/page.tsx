import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import { getResellerBuyRate, getResellerSellRate, computeResellerMargin } from "@/lib/reseller/pricing";
import { PageHeader } from "@/components/ui/PageHeader";

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
      <div>
        <PageHeader title="Margin" />
        <div className="card">
          <p className="error">This page is only available to reseller accounts.</p>
        </div>
      </div>
    );
  }

  const margin = await withTenant(session.orgId, session.userId, async (client) => {
    const buy = await getResellerBuyRate(client, session.orgId);
    const sell = await getResellerSellRate(client, session.orgId);
    return computeResellerMargin(buy, sell);
  });

  return (
    <div>
      <PageHeader
        title="Margin"
        description="Your own buy cost vs your own sell price — the platform's underlying vendor rate cards are never exposed to a reseller."
      />
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Your buy cost</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {margin.buyPricePerMinuteUsd !== null ? `$${margin.buyPricePerMinuteUsd.toFixed(6)}/min` : "not set"}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Your sell price</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {margin.sellPricePerMinuteUsd !== null ? `$${margin.sellPricePerMinuteUsd.toFixed(6)}/min` : "not set"}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Your margin</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {margin.marginPerMinuteUsd !== null ? `$${margin.marginPerMinuteUsd.toFixed(6)}/min` : "—"}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Margin %</div>
          <div className="stat-value">{margin.marginPercent !== null ? `${margin.marginPercent.toFixed(1)}%` : "—"}</div>
        </div>
      </div>
    </div>
  );
}
