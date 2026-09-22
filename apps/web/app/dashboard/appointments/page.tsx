import { getSession } from "@/lib/auth";
import { listAppointments } from "@/lib/data/appointments";

export default async function AppointmentsPage() {
  const session = await getSession();
  if (!session) return null;

  const appointments = await listAppointments(session.orgId, session.userId);

  return (
    <div className="card">
      <h1>Appointments</h1>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Generalized &ldquo;site visits&rdquo; — an appointment can be a site visit, demo, consultation, or pickup
        depending on the tenant&apos;s vertical (see docs/CRM_LOGIC.md and the Phase 6 migration). Reminders
        are queued automatically via the WhatsApp provider registry.
      </p>
      {appointments.length === 0 ? (
        <p className="empty-state">
          No appointments yet. Appointments created from calls (or booked manually via POST /api/appointments)
          will show up here with their scheduled time, status, and reminder state.
        </p>
      ) : (
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
                <td>{a.status}</td>
                <td>{a.location_or_link ?? "—"}</td>
                <td>{a.reminder_sent_at ? new Date(a.reminder_sent_at).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
