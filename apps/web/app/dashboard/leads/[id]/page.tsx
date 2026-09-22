import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getLead, getLeadCallSummaries } from "@/lib/data/leads";
import { getLeadStageHistory } from "@/lib/crm/pipeline";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge, toneForStatus } from "@/components/ui/Badge";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return null;
  const { id } = await params;

  const lead = await getLead(session.orgId, session.userId, id);
  if (!lead) notFound();

  const [summaries, history] = await Promise.all([
    getLeadCallSummaries(session.orgId, session.userId, id),
    getLeadStageHistory(session.orgId, session.userId, id),
  ]);

  return (
    <div>
      <PageHeader
        title={lead.full_name ?? "(no name)"}
        breadcrumbs={[{ label: "Leads", href: "/dashboard/leads" }, { label: lead.full_name ?? "(no name)" }]}
      />

      <div className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div className="table-wrap">
          <table className="kv-table">
            <tbody>
              <tr>
                <th>Phone</th>
                <td>{lead.phone_number ?? "—"}</td>
              </tr>
              <tr>
                <th>Stage</th>
                <td>{lead.pipeline_stage_name ?? "—"}</td>
              </tr>
              <tr>
                <th>Score</th>
                <td>
                  {lead.score_band ? (
                    <Badge tone={toneForStatus(lead.score_band)}>
                      {lead.score_band.toUpperCase()} ({lead.score})
                    </Badge>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
              <tr>
                <th>Last disposition</th>
                <td>{lead.last_disposition_name ?? "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-4)" }}>
        <h2>Call summaries</h2>
        {summaries.length === 0 ? (
          <EmptyState title="No call summaries yet" description="Summaries appear here once this lead has been called." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Requirement</th>
                  <th>Budget</th>
                  <th>Location</th>
                  <th>Next action</th>
                  <th>Follow-up</th>
                  <th>Score</th>
                  <th>Needs review</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => (
                  <tr key={s.id}>
                    <td>{s.requirement_text ?? "—"}</td>
                    <td>{s.budget_value ?? "—"}</td>
                    <td>{s.location ?? "—"}</td>
                    <td>{s.next_action ?? "—"}</td>
                    <td>{s.follow_up_date ?? "—"}</td>
                    <td>{s.lead_score_at_call ?? "—"}</td>
                    <td>
                      <Badge tone={s.needs_review ? "warning" : "success"}>{s.needs_review ? "Yes" : "No"}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Stage history</h2>
        {history.length === 0 ? (
          <EmptyState title="No stage transitions recorded yet" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>Note</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.from_stage_name ?? "(none)"}</td>
                    <td>{h.to_stage_name ?? "(none)"}</td>
                    <td>{h.note ?? "—"}</td>
                    <td>{new Date(h.created_at).toLocaleString()}</td>
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
