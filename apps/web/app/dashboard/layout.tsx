import { redirect } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { logoutAction } from "../(auth)/actions";
import { resolveTenantBranding } from "@/lib/reseller/branding";

// Testable white-label routing mechanism for this phase (no real DNS/SSL
// infra in a dev sandbox — see docs/RESELLER_HIERARCHY.md "Domain routing").
// The platform's own base domain, below which every {reseller-slug}.<this>
// host resolves to that reseller's branding.
const PLATFORM_BASE_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_BASE_DOMAIN ?? "yourplatform.example";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const headersList = await headers();
  const branding = await resolveTenantBranding(headersList, PLATFORM_BASE_DOMAIN);

  const chromeStyle = branding
    ? ({
        "--primary": branding.primaryColor ?? undefined,
        "--secondary": branding.secondaryColor ?? undefined,
      } as React.CSSProperties)
    : undefined;

  return (
    <div style={chromeStyle}>
      <nav className="topbar">
        <div>
          {branding?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={branding.logoUrl} alt={branding.companyName ?? "logo"} style={{ height: "24px", marginRight: "0.5rem" }} />
          )}
          <strong style={{ marginRight: "1rem" }}>{branding?.companyName ?? "AI Calling Agent"}</strong>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/dashboard/agents">Agents</Link>
          <Link href="/dashboard/leads">Leads</Link>
          <Link href="/dashboard/appointments">Appointments</Link>
          <Link href="/dashboard/billing/invoices">Invoices</Link>
          {session.orgRole === "platform" && (
            <>
              <Link href="/dashboard/billing/simulator">Cost Simulator</Link>
              <Link href="/dashboard/admin/provider-scoreboard">Provider Scoreboard</Link>
              <Link href="/dashboard/admin/resellers">Resellers</Link>
            </>
          )}
          {session.orgRole === "reseller" && (
            <>
              <Link href="/dashboard/reseller/customers">Customers</Link>
              <Link href="/dashboard/reseller/pricing">Pricing</Link>
              <Link href="/dashboard/reseller/margin">Margin</Link>
              <Link href="/dashboard/reseller/starter-kit">Starter Kit</Link>
            </>
          )}
        </div>
        <form action={logoutAction}>
          <button type="submit">Log out</button>
        </form>
      </nav>
      <div className="container">{children}</div>
      {branding?.supportEmail || branding?.supportPhone ? (
        <p style={{ padding: "0 1rem", color: "var(--muted)" }}>
          Support: {branding.supportEmail ?? ""} {branding.supportPhone ?? ""}
        </p>
      ) : null}
    </div>
  );
}
