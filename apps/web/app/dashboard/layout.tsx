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
        </div>
        <form action={logoutAction}>
          <button type="submit">Log out</button>
        </form>
      </nav>
      <div className="container">{children}</div>
    </div>
  );
}
