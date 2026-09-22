import { withTenant } from "../db/tenant";

export type AppointmentListRow = {
  id: string;
  lead_id: string;
  lead_name: string | null;
  type: string;
  scheduled_at: string;
  status: string;
  location_or_link: string | null;
  reminder_sent_at: string | null;
  updated_at: string;
};

/** Lists appointments for the caller's org — the "plumbing proof" list the
 * dashboard page renders (same austerity level as Phase 1/5's UI). */
export async function listAppointments(orgId: string, userId: string): Promise<AppointmentListRow[]> {
  return withTenant(orgId, userId, async (client) => {
    const { rows } = await client.query<AppointmentListRow>(
      `SELECT a.id, a.lead_id, l.full_name AS lead_name, a.type, a.scheduled_at, a.status,
              a.location_or_link, a.reminder_sent_at, a.updated_at
         FROM appointments a JOIN leads l ON l.id = a.lead_id
        WHERE a.org_id = $1
        ORDER BY a.scheduled_at ASC`,
      [orgId]
    );
    return rows;
  });
}
