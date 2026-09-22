import { redirect } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { logoutAction } from "../(auth)/actions";
import { resolveTenantBranding } from "@/lib/reseller/branding";
import { SidebarToggle, SidebarScrim } from "@/components/ui/SidebarToggle";

// Testable white-label routing mechanism for this phase (no real DNS/SSL
// infra in a dev sandbox — see docs/RESELLER_HIERARCHY.md "Domain routing").
// The platform's own base domain, below which every {reseller-slug}.<this>
// host resolves to that reseller's branding.
const PLATFORM_BASE_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_BASE_DOMAIN ?? "yourplatform.example";

type NavItem = { href: string; label: string };

const ORG_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/agents", label: "Agents" },
  { href: "/dashboard/leads", label: "Leads" },
  { href: "/dashboard/appointments", label: "Appointments" },
  { href: "/dashboard/analytics", label: "Analytics" },
  { href: "/dashboard/billing/invoices", label: "Invoices" },
  { href: "/dashboard/settings/n8n", label: "n8n Webhooks" },
];

const RESELLER_NAV: NavItem[] = [
  { href: "/dashboard/reseller/customers", label: "Customers" },
  { href: "/dashboard/reseller/pricing", label: "Pricing" },
  { href: "/dashboard/reseller/margin", label: "Margin" },
  { href: "/dashboard/reseller/starter-kit", label: "Starter Kit" },
];

const PLATFORM_NAV: NavItem[] = [
  { href: "/dashboard/billing/simulator", label: "Cost Simulator" },
  { href: "/dashboard/admin/provider-scoreboard", label: "Provider Scoreboard" },
  { href: "/dashboard/admin/resellers", label: "Resellers" },
  { href: "/dashboard/admin/analytics", label: "Platform Analytics" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const headersList = await headers();
  const branding = await resolveTenantBranding(headersList, PLATFORM_BASE_DOMAIN);

  // White-label theming hook: reseller_branding's colors override the
  // default Navy/Gold theme tokens at runtime, scoped to this shell element
  // via CSS custom properties (see app/globals.css :root defaults).
  const chromeStyle: React.CSSProperties = {};
  if (branding?.primaryColor) {
    chromeStyle["--color-primary" as keyof React.CSSProperties] = branding.primaryColor as never;
    chromeStyle["--color-primary-hover" as keyof React.CSSProperties] = branding.primaryColor as never;
  }
  if (branding?.secondaryColor) {
    chromeStyle["--color-accent" as keyof React.CSSProperties] = branding.secondaryColor as never;
    chromeStyle["--color-accent-hover" as keyof React.CSSProperties] = branding.secondaryColor as never;
  }

  const orgName = branding?.companyName ?? "AI Calling Agent";

  return (
    <div className="app-shell" style={chromeStyle} data-branded={branding ? "true" : "false"}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          {branding?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={branding.logoUrl} alt={orgName} />
          )}
          <strong>{orgName}</strong>
        </div>
        <nav className="sidebar-nav">
          <div className="sidebar-section-label">Your workspace</div>
          {ORG_NAV.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}

          {session.orgRole === "reseller" && (
            <>
              <div className="sidebar-section-label">Reseller</div>
              {RESELLER_NAV.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </>
          )}

          {session.orgRole === "platform" && (
            <>
              <div className="sidebar-section-label">Platform admin</div>
              {PLATFORM_NAV.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-user">
            {session.userId}
            <span className="org-role">{session.role} · {session.orgRole}</span>
          </div>
          <form action={logoutAction}>
            <button type="submit">Log out</button>
          </form>
        </div>
      </aside>
      <SidebarScrim />
      <div className="app-main">
        <div className="app-topbar">
          <SidebarToggle />
          <strong>{orgName}</strong>
        </div>
        <div className="app-content">{children}</div>
        {(branding?.supportEmail || branding?.supportPhone) && (
          <p className="support-footer">
            Support: {branding?.supportEmail ?? ""} {branding?.supportPhone ?? ""}
          </p>
        )}
      </div>
    </div>
  );
}
