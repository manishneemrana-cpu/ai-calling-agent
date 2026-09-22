import { getSession } from "@/lib/auth";
import { loadTenantAnalyticsSummary, loadTeamPerformance, loadCampaignPerformance } from "@/lib/analytics/tenant";

/**
 * /dashboard/analytics — Phase 9 tenant-scoped analytics dashboard.
 * Plumbing-proof (plain numbers/tables), real queries against this org's
 * OWN calls/leads/cost_records/appointments/wallets/campaigns — never
 * platform-wide cost (see /dashboard/admin/analytics for that, gated to
 * platform/reseller sessions only).
 */
export default async function TenantAnalyticsPage() {
  const session = await getSession();
  if (!session) return null;

  const [summary, team, campaigns] = await Promise.all([
    loadTenantAnalyticsSummary(session.orgId, session.userId),
    loadTeamPerformance(session.orgId, session.userId),
    loadCampaignPerformance(session.orgId, session.userId),
  ]);

  return (
    <div className="card">
      <h1>Analytics</h1>
      <table style={{ marginBottom: "1.5rem" }}>
        <tbody>
          <tr>
            <td>Total leads</td>
            <td>{summary.totalLeads}</td>
          </tr>
          <tr>
            <td>Total calls</td>
            <td>{summary.totalCalls}</td>
          </tr>
          <tr>
            <td>Connected calls</td>
            <td>
              {summary.connectedCalls} ({summary.connectedRatePct.toFixed(1)}%)
            </td>
          </tr>
          <tr>
            <td>Average call duration (s)</td>
            <td>{summary.avgCallDurationSeconds.toFixed(1)}</td>
          </tr>
          <tr>
            <td>Qualified leads</td>
            <td>{summary.qualifiedLeads}</td>
          </tr>
          <tr>
            <td>Hot leads</td>
            <td>{summary.hotLeads}</td>
          </tr>
          <tr>
            <td>Appointments scheduled</td>
            <td>{summary.appointmentsScheduled}</td>
          </tr>
          <tr>
            <td>Follow-ups due</td>
            <td>{summary.followUpsDue}</td>
          </tr>
          <tr>
            <td>Conversions</td>
            <td>{summary.conversions}</td>
          </tr>
          <tr>
            <td>AI cost (your own, USD)</td>
            <td>{summary.aiCostUsd.toFixed(4)}</td>
          </tr>
          <tr>
            <td>Wallet balance</td>
            <td>{summary.walletBalance.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>

      <h2>Team performance</h2>
      {team.length === 0 ? (
        <p className="empty-state">No users yet.</p>
      ) : (
        <table style={{ marginBottom: "1.5rem" }}>
          <thead>
            <tr>
              <th>User</th>
              <th>Assigned leads</th>
              <th>Conversions</th>
            </tr>
          </thead>
          <tbody>
            {team.map((t) => (
              <tr key={t.userId}>
                <td>{t.fullName ?? t.userId}</td>
                <td>{t.assignedLeads}</td>
                <td>{t.conversions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Campaign performance</h2>
      {campaigns.length === 0 ? (
        <p className="empty-state">No campaigns yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Status</th>
              <th>Total leads</th>
              <th>Completed</th>
              <th>Total attempts</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.campaignId}>
                <td>{c.name}</td>
                <td>{c.status}</td>
                <td>{c.totalLeads}</td>
                <td>{c.completedLeads}</td>
                <td>{c.totalAttempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
