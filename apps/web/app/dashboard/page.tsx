import { getSession } from "@/lib/auth";
import { getCurrentOrganization, countOrgUsers } from "@/lib/data/organizations";

export default async function DashboardHomePage() {
  const session = await getSession();
  if (!session) return null; // layout already redirects; satisfies TS

  const [org, userCount] = await Promise.all([
    getCurrentOrganization(session.orgId, session.userId),
    countOrgUsers(session.orgId, session.userId),
  ]);

  return (
    <div className="card">
      <h1>Welcome</h1>
      {org ? (
        <>
          <p>
            Organization: <strong>{org.name}</strong> ({org.slug})
          </p>
          <p>Tier: {org.tier}</p>
          <p>Users in this org: {userCount}</p>
          <p style={{ color: "var(--muted)" }}>Your role: {session.role}</p>
        </>
      ) : (
        <p className="error">Could not load organization.</p>
      )}
    </div>
  );
}
