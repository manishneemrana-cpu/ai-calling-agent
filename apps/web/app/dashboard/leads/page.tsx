import Link from "next/link";
import { getSession } from "@/lib/auth";
import { listLeads } from "@/lib/data/leads";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge, toneForStatus } from "@/components/ui/Badge";

export default async function LeadsPage() {
  const session = await getSession();
  if (!session) return null;

  const leads = await listLeads(session.orgId, session.userId);

  return (
    <div>
      <PageHeader title="Leads" description="Everyone your agents have qualified, ranked by score and pipeline stage." />
      <div className="card">
        {leads.length === 0 ? (
          <EmptyState
            title="No leads yet"
            description="Leads created from calls (or imported) will show up here with their pipeline stage, score band, and last disposition."
          />
        ) : (
          <div className="table-wrap">
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
                      {l.score_band ? (
                        <Badge tone={toneForStatus(l.score_band)}>
                          {l.score_band.toUpperCase()} ({l.score})
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{l.last_disposition_name ?? "—"}</td>
                    <td>{l.next_follow_up_at ? new Date(l.next_follow_up_at).toLocaleDateString() : "—"}</td>
                    <td>{new Date(l.updated_at).toLocaleDateString()}</td>
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
