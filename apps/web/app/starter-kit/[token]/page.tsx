import { withoutTenant } from "@/lib/db/tenant";
import { readStarterKitShare } from "@/lib/reseller/starterKit";
import { computeResellerStarterKitTable, DEFAULT_STARTER_KIT_TIERS_MINUTES } from "@/lib/reseller/starterKit";

/**
 * /starter-kit/[token] — a prospect-facing, unauthenticated page (a
 * prospect is not a platform user and never logs in). Reads a single
 * `reseller_starter_kit_shares` snapshot by opaque token via the
 * `get_starter_kit_share()` SECURITY DEFINER function, which returns ONLY
 * the snapshotted buy/sell numbers for that one reseller — never anything
 * about any other reseller or the platform's own rate cards.
 */
export default async function StarterKitSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const snapshot = await withoutTenant(async (client) => readStarterKitShare(client, token));

  if (!snapshot) {
    return (
      <div className="container">
        <div className="card">
          <h1>Link not found or expired</h1>
        </div>
      </div>
    );
  }

  const rows = computeResellerStarterKitTable(
    DEFAULT_STARTER_KIT_TIERS_MINUTES,
    snapshot.buyPricePerMinuteUsd,
    snapshot.sellPricePerMinuteUsd
  );

  return (
    <div className="container">
      <div className="card">
        <h1>{snapshot.planLabel ?? "Cost estimate"}</h1>
        {snapshot.prospectName && <p>Prepared for: {snapshot.prospectName}</p>}
        <p>Estimated usage: {snapshot.estimatedMinutesPerMonth.toLocaleString()} minutes/month</p>
        {/* Deliberately shows only the price the prospect would pay — never
            the reseller's own buy cost or margin (that's the reseller's
            business, not the prospect's), even though the snapshot this
            page reads does carry both numbers server-side. */}
        <table>
          <thead>
            <tr>
              <th>Minutes/month</th>
              <th>Estimated price ({snapshot.currency})</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.minutesPerMonth}>
                <td>{r.minutesPerMonth.toLocaleString()}</td>
                <td>${r.revenueUsd.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
