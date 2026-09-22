import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getLead, getLeadCallSummaries } from "@/lib/data/leads";
import { getLeadStageHistory } from "@/lib/crm/pipeline";

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
    <div className="card">
      <h1>{lead.full_name ?? "(no name)"}</h1>
      <p className="empty-state">
        {lead.phone_number ?? "—"} · Stage: {lead.pipeline_stage_name ?? "—"} · Score:{" "}
        {lead.score_band ? `${lead.score_band.toUpperCase()} (${lead.score})` : "—"} · Last disposition:{" "}
        {lead.last_disposition_name ?? "—"}
      </p>

      <h2>Call summaries</h2>
      {summaries.length === 0 ? (
        <p className="empty-state">No call summaries yet.</p>
      ) : (
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
                <td>{s.needs_review ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Stage history</h2>
      {history.length === 0 ? (
        <p className="empty-state">No stage transitions recorded yet.</p>
      ) : (
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
      )}
    </div>
  );
}
