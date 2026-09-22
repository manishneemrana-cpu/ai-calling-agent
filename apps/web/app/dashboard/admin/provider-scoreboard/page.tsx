import { getSession } from "@/lib/auth";
import { withoutTenant } from "@/lib/db/tenant";
import {
  buildScoreboard,
  loadProviderCostStats,
  loadProviderFailoverStats,
  loadProviderLatencyStats,
  loadProviderQualityRatings,
} from "@/lib/billing/scoreboard";

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
      <div className="card">
        <h1>Provider Scoreboard</h1>
        <p className="error">Platform-owner only.</p>
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
    <div className="card">
      <h1>Provider Scoreboard</h1>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Aggregates REAL data already collected: Phase 3.5/4&apos;s <code>cost_records</code> for actual
        per-unit vendor cost, and Phase 3&apos;s per-call latency measurements (persisted via the Phase 7{" "}
        <code>call_latency_metrics</code> sink) for average latency. <strong>&ldquo;Hinglish quality&rdquo; is
        a manually/admin-entered rating (<code>provider_quality_ratings</code>), not an automatic score</strong> —
        it cannot be measured from usage data alone, so this page does not fabricate one. The composite score
        formula and its weights are documented in lib/billing/scoreboard.ts (DEFAULT_SCOREBOARD_WEIGHTS) and
        are configurable, not hardcoded business logic.
      </p>
      {rows.length === 0 ? (
        <p className="empty-state">No cost_records yet — place a few calls to see real per-provider stats here.</p>
      ) : (
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
      )}

      <h2 style={{ marginTop: "2rem" }}>Failover frequency</h2>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Gap-closing pass: Phase 9 built <code>provider_failover_events</code> / <code>platform_failover_stats()</code>{" "}
        but never surfaced them in this UI — wired in now, no new data collection. Counts every recorded
        primary-to-fallback provider switch, across every tenant.
      </p>
      {failoverStats.length === 0 ? (
        <p className="empty-state">No failover events recorded yet.</p>
      ) : (
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
      )}
    </div>
  );
}
