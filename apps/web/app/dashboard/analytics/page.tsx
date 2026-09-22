import { getSession } from "@/lib/auth";
import { loadTenantAnalyticsSummary, loadTeamPerformance, loadCampaignPerformance } from "@/lib/analytics/tenant";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge, toneForStatus } from "@/components/ui/Badge";

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
    <div>
      <PageHeader title="Analytics" description="Your organization's own performance — leads, calls, campaigns and cost." />

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Total leads</div>
          <div className="stat-value">{summary.totalLeads}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total calls</div>
          <div className="stat-value">{summary.totalCalls}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Connected calls</div>
          <div className="stat-value">
            {summary.connectedCalls} <span style={{ fontSize: 14 }}>({summary.connectedRatePct.toFixed(1)}%)</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Avg call duration (s)</div>
          <div className="stat-value">{summary.avgCallDurationSeconds.toFixed(1)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Qualified leads</div>
          <div className="stat-value">{summary.qualifiedLeads}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Hot leads</div>
          <div className="stat-value">{summary.hotLeads}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Appointments scheduled</div>
          <div className="stat-value">{summary.appointmentsScheduled}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Follow-ups due</div>
          <div className="stat-value">{summary.followUpsDue}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Conversions</div>
          <div className="stat-value">{summary.conversions}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">AI cost (USD)</div>
          <div className="stat-value" style={{ fontSize: 18 }}>{summary.aiCostUsd.toFixed(4)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Wallet balance</div>
          <div className="stat-value" style={{ fontSize: 18 }}>{summary.walletBalance.toFixed(2)}</div>
        </div>
      </div>

      <div className="card">
        <h2>Team performance</h2>
        {team.length === 0 ? (
          <EmptyState title="No users yet" />
        ) : (
          <div className="table-wrap">
            <table>
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
          </div>
        )}
      </div>

      <div className="card">
        <h2>Campaign performance</h2>
        {campaigns.length === 0 ? (
          <EmptyState title="No campaigns yet" />
        ) : (
          <div className="table-wrap">
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
                    <td>
                      <Badge tone={toneForStatus(c.status)}>{c.status}</Badge>
                    </td>
                    <td>{c.totalLeads}</td>
                    <td>{c.completedLeads}</td>
                    <td>{c.totalAttempts}</td>
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
