import { getSession } from "@/lib/auth";
import { withoutTenant } from "@/lib/db/tenant";
import {
  buildScoreboard,
  loadProviderCostStats,
  loadProviderFailoverStats,
  loadProviderLatencyStats,
  loadProviderQualityRatings,
} from "@/lib/billing/scoreboard";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * /dashboard/admin/provider-scoreboard — plumbing-proof Provider
 * Scoreboard page. Platform-level (not tenant-scoped — cost/latency stats
 * span every org's usage, same rationale as `provider_rate_cards`/
 * `providers` themselves), hence `withoutTenant`.
 *
 * HONEST CAVEAT, shown directly in the UI: "Hinglish quality" is a
 * manually/admin-entered rating (`provider_quality_ratings`), never an
 * automatic score — this page never fabricates one.
 *
 * Phase 8 hardening: this page aggregates REAL cost across every tenant, so
 * it is now platform-owner-only (session.orgRole === "platform") — a
 * reseller must never see platform-level cost, per that phase's hard rule.
 * Phase 7 originally gated this only on "any logged-in user", which this
 * fixes.
 */
export default async function ProviderScoreboardPage() {
  const session = await getSession();
  if (!session) return null;
  if (session.orgRole !== "platform") {
    return (
      <div>
        <PageHeader title="Provider Scoreboard" />
        <div className="card">
          <p className="error">Platform-owner only.</p>
        </div>
      </div>
    );
  }

  const { costStats, latencyStats, qualityRatings, failoverStats } = await withoutTenant(async (client) => ({
    costStats: await loadProviderCostStats(client),
    latencyStats: await loadProviderLatencyStats(client),
    qualityRatings: await loadProviderQualityRatings(client),
    failoverStats: await loadProviderFailoverStats(client),
  }));

  const rows = buildScoreboard(costStats, latencyStats, qualityRatings);

  return (
    <div>
      <PageHeader
        title="Provider Scoreboard"
        description={
          <>
            Real cost and latency data per provider. &ldquo;Hinglish quality&rdquo; is a manually-entered rating,
            never an automatic score.
          </>
        }
      />
      <div className="card">
        {rows.length === 0 ? (
          <EmptyState title="No cost data yet" description="Place a few calls to see real per-provider stats here." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Layer</th>
                  <th>Provider</th>
                  <th>Avg cost/unit (USD)</th>
                  <th>Avg latency (s)</th>
                  <th>Manual quality (0-10)</th>
                  <th>Composite score</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.layer}:${r.providerKey}`}>
                    <td>{r.layer}</td>
                    <td>{r.providerKey}</td>
                    <td>{r.avgCostPerUnit !== null ? r.avgCostPerUnit.toFixed(6) : "—"}</td>
                    <td>{r.avgLatencyS !== null ? r.avgLatencyS.toFixed(3) : "no data yet"}</td>
                    <td>{r.manualQualityScore !== null ? r.manualQualityScore.toFixed(1) : "not rated"}</td>
                    <td>{r.compositeScore !== null ? r.compositeScore.toFixed(3) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Failover frequency</h2>
        <p className="text-muted">Counts every recorded primary-to-fallback provider switch, across every tenant.</p>
        {failoverStats.length === 0 ? (
          <EmptyState title="No failover events recorded yet" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Layer</th>
                  <th>From provider</th>
                  <th>To provider</th>
                  <th>Event count</th>
                  <th>Last event</th>
                </tr>
              </thead>
              <tbody>
                {failoverStats.map((f) => (
                  <tr key={`${f.layer}:${f.fromProvider}:${f.toProvider}`}>
                    <td>{f.layer}</td>
                    <td>{f.fromProvider}</td>
                    <td>{f.toProvider}</td>
                    <td>{f.eventCount}</td>
                    <td>{new Date(f.lastEventAt).toLocaleString()}</td>
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
