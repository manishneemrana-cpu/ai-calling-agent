import { getSession } from "@/lib/auth";
import { listAppointments } from "@/lib/data/appointments";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge, toneForStatus } from "@/components/ui/Badge";

export default async function AppointmentsPage() {
  const session = await getSession();
  if (!session) return null;

  const appointments = await listAppointments(session.orgId, session.userId);

  return (
    <div>
      <PageHeader
        title="Appointments"
        description={
          'Generalized "site visits" — an appointment can be a site visit, demo, consultation, or pickup depending on the tenant\'s vertical. Reminders are queued automatically via the WhatsApp provider registry.'
        }
      />
      <div className="card">
        {appointments.length === 0 ? (
          <EmptyState
            title="No appointments yet"
            description="Appointments created from calls (or booked manually via POST /api/appointments) will show up here with their scheduled time, status, and reminder state."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Type</th>
                  <th>Scheduled</th>
                  <th>Status</th>
                  <th>Location / link</th>
                  <th>Reminder sent</th>
                </tr>
              </thead>
              <tbody>
                {appointments.map((a) => (
                  <tr key={a.id}>
                    <td>{a.lead_name ?? "(no name)"}</td>
                    <td>{a.type}</td>
                    <td>{new Date(a.scheduled_at).toLocaleString()}</td>
                    <td>
                      <Badge tone={toneForStatus(a.status)}>{a.status}</Badge>
                    </td>
                    <td>{a.location_or_link ?? "—"}</td>
                    <td>{a.reminder_sent_at ? new Date(a.reminder_sent_at).toLocaleString() : "—"}</td>
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
