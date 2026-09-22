import Link from "next/link";
import { getSession } from "@/lib/auth";
import { listLeads } from "@/lib/data/leads";

export default async function LeadsPage() {
  const session = await getSession();
  if (!session) return null;

  const leads = await listLeads(session.orgId, session.userId);

  return (
    <div className="card">
      <h1>Leads</h1>
      {leads.length === 0 ? (
        <p className="empty-state">
          No leads yet. Leads created from calls (or imported) will show up here with their pipeline
          stage, score band, and last disposition.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Stage</th>
              <th>Score</th>
              <th>Last disposition</th>
              <th>Next follow-up</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link href={`/dashboard/leads/${l.id}`}>{l.full_name ?? "(no name)"}</Link>
                </td>
                <td>{l.phone_number ?? "—"}</td>
                <td>{l.pipeline_stage_name ?? "—"}</td>
                <td>
                  {l.score_band ? `${l.score_band.toUpperCase()} (${l.score})` : "—"}
                </td>
                <td>{l.last_disposition_name ?? "—"}</td>
                <td>{l.next_follow_up_at ? new Date(l.next_follow_up_at).toLocaleDateString() : "—"}</td>
                <td>{new Date(l.updated_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
