import { getSession } from "@/lib/auth";
import { getCurrentOrganization, countOrgUsers } from "@/lib/data/organizations";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, toneForStatus } from "@/components/ui/Badge";

export default async function DashboardHomePage() {
  const session = await getSession();
  if (!session) return null; // layout already redirects; satisfies TS

  const [org, userCount] = await Promise.all([
    getCurrentOrganization(session.orgId, session.userId),
    countOrgUsers(session.orgId, session.userId),
  ]);

  return (
    <div>
      <PageHeader title="Welcome" description="A snapshot of your organization." />
      {org ? (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-label">Organization</div>
              <div className="stat-value" style={{ fontSize: 18 }}>
                {org.name}
              </div>
              <p className="field-hint" style={{ marginTop: 4 }}>{org.slug}</p>
            </div>
            <div className="stat-card">
              <div className="stat-label">Tier</div>
              <div className="stat-value" style={{ fontSize: 18 }}>
                {org.tier}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Users in this org</div>
              <div className="stat-value">{userCount}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Your role</div>
              <div style={{ marginTop: 4 }}>
                <Badge tone={toneForStatus(session.role)}>{session.role}</Badge>
              </div>
            </div>
          </div>
        </>
      ) : (
        <p className="error">Could not load organization.</p>
      )}
    </div>
  );
}
