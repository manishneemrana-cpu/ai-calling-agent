import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { logoutAction } from "../(auth)/actions";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  return (
    <div>
      <nav className="topbar">
        <div>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/dashboard/agents">Agents</Link>
          <Link href="/dashboard/leads">Leads</Link>
          <Link href="/dashboard/appointments">Appointments</Link>
          <Link href="/dashboard/billing/simulator">Cost Simulator</Link>
          <Link href="/dashboard/billing/invoices">Invoices</Link>
          <Link href="/dashboard/admin/provider-scoreboard">Provider Scoreboard</Link>
        </div>
        <form action={logoutAction}>
          <button type="submit">Log out</button>
        </form>
      </nav>
      <div className="container">{children}</div>
    </div>
  );
}
