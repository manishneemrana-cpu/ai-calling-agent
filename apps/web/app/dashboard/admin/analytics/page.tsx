import { getSession } from "@/lib/auth";
import { withoutTenant } from "@/lib/db/tenant";
import {
  loadPlatformAnalyticsSummary,
  loadResellerAnalyticsSummary,
  type PlatformAnalyticsSummary,
  type ResellerAnalyticsSummary,
} from "@/lib/analytics/platform";
import { PageHeader } from "@/components/ui/PageHeader";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ fontSize: 20 }}>{value}</div>
    </div>
  );
}

function CommonStats({ summary }: { summary: PlatformAnalyticsSummary | ResellerAnalyticsSummary }) {
  return (
    <>
      <Stat label="Total tenants" value={summary.totalTenants} />
      <Stat label="Calls today" value={summary.callsToday} />
      <Stat label="Connected calls today" value={summary.connectedCallsToday} />
      <Stat label="Total minutes (all time)" value={summary.totalMinutesAllTime.toFixed(1)} />
      <Stat label="AI cost (USD)" value={summary.totalAiCostUsd.toFixed(4)} />
      <Stat label="Revenue (USD)" value={summary.totalRevenue.toFixed(4)} />
      <Stat label="Gross margin (USD)" value={summary.grossMarginUsd.toFixed(4)} />
      <Stat label="Hot leads" value={summary.hotLeads} />
      <Stat label="Appointments scheduled" value={summary.appointmentsScheduled} />
      <Stat label="Failed calls today" value={summary.failedCallsToday} />
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
      <div>
        <PageHeader title="Analytics" />
        <div className="card">
          <p className="error">
            This dashboard is for the platform owner or a reseller. See /dashboard/analytics for your own org&apos;s
            analytics.
          </p>
        </div>
      </div>
    );
  }

  const isPlatform = session.orgRole === "platform";

  return (
    <div>
      <PageHeader
        title={isPlatform ? "Platform Analytics" : "My Resold Tenants — Analytics"}
        description={
          isPlatform
            ? "Aggregated across every tenant on the platform."
            : "Aggregated across your own org and the customer orgs you resell to — never platform-wide cost."
        }
      />
      {isPlatform ? <PlatformStats /> : <ResellerStats orgId={session.orgId} />}
    </div>
  );
}

async function PlatformStats() {
  const summary = await withoutTenant((client) => loadPlatformAnalyticsSummary(client));
  return (
    <div className="stat-grid">
      <CommonStats summary={summary} />
      <Stat label="Active tenants (30d)" value={summary.activeTenants} />
      <Stat label="Active agents" value={summary.activeAgents} />
      <Stat label="Active campaigns" value={summary.activeCampaigns} />
    </div>
  );
}

async function ResellerStats({ orgId }: { orgId: string }) {
  const summary = await withoutTenant((client) => loadResellerAnalyticsSummary(client, orgId));
  return (
    <div className="stat-grid">
      <CommonStats summary={summary} />
    </div>
  );
}
