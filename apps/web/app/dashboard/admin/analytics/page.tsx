import { getSession } from "@/lib/auth";
import { withoutTenant } from "@/lib/db/tenant";
import {
  loadPlatformAnalyticsSummary,
  loadResellerAnalyticsSummary,
  type PlatformAnalyticsSummary,
  type ResellerAnalyticsSummary,
} from "@/lib/analytics/platform";

function CommonRows({ summary }: { summary: PlatformAnalyticsSummary | ResellerAnalyticsSummary }) {
  return (
    <>
      <tr>
        <td>Total tenants</td>
        <td>{summary.totalTenants}</td>
      </tr>
      <tr>
        <td>Calls today</td>
        <td>{summary.callsToday}</td>
      </tr>
      <tr>
        <td>Connected calls today</td>
        <td>{summary.connectedCallsToday}</td>
      </tr>
      <tr>
        <td>Total minutes (all time)</td>
        <td>{summary.totalMinutesAllTime.toFixed(1)}</td>
      </tr>
      <tr>
        <td>AI cost (USD)</td>
        <td>{summary.totalAiCostUsd.toFixed(4)}</td>
      </tr>
      <tr>
        <td>Revenue (billed to tenants, USD)</td>
        <td>{summary.totalRevenue.toFixed(4)}</td>
      </tr>
      <tr>
        <td>Gross margin (USD)</td>
        <td>{summary.grossMarginUsd.toFixed(4)}</td>
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
        <td>Failed calls today</td>
        <td>{summary.failedCallsToday}</td>
      </tr>
    </>
  );
}

/**
 * /dashboard/admin/analytics — Phase 9 admin analytics dashboard.
 * Plumbing-proof (plain numbers/tables), real queries against Phase 5/6/7
 * data. Platform owner sees `platform_analytics_summary()` (every tenant);
 * a reseller sees `reseller_analytics_summary(own org id)` — its own +
 * customer orgs ONLY, never platform-wide raw cost, per Phase 8's hard
 * visibility rule. A plain customer gets no access to this page at all.
 */
export default async function AdminAnalyticsPage() {
  const session = await getSession();
  if (!session) return null;

  if (session.orgRole === "customer") {
    return (
      <div className="card">
        <h1>Analytics</h1>
        <p className="error">This dashboard is for the platform owner or a reseller. See /dashboard/analytics for your own org&apos;s analytics.</p>
      </div>
    );
  }

  const isPlatform = session.orgRole === "platform";

  return (
    <div className="card">
      <h1>{isPlatform ? "Platform Analytics" : "My Resold Tenants — Analytics"}</h1>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        {isPlatform
          ? "Aggregated across every tenant on the platform."
          : "Aggregated across your own org and the customer orgs you resell to — never platform-wide cost (Phase 8 visibility rule)."}
      </p>
      {isPlatform ? (
        <PlatformTable />
      ) : (
        <ResellerTable orgId={session.orgId} />
      )}
    </div>
  );
}

async function PlatformTable() {
  const summary = await withoutTenant((client) => loadPlatformAnalyticsSummary(client));
  return (
    <table>
      <tbody>
        <CommonRows summary={summary} />
        <tr>
          <td>Active tenants (call in last 30 days)</td>
          <td>{summary.activeTenants}</td>
        </tr>
        <tr>
          <td>Active agents</td>
          <td>{summary.activeAgents}</td>
        </tr>
        <tr>
          <td>Active campaigns</td>
          <td>{summary.activeCampaigns}</td>
        </tr>
      </tbody>
    </table>
  );
}

async function ResellerTable({ orgId }: { orgId: string }) {
  const summary = await withoutTenant((client) => loadResellerAnalyticsSummary(client, orgId));
  return (
    <table>
      <tbody>
        <CommonRows summary={summary} />
      </tbody>
    </table>
  );
}
