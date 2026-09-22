import { withTenant } from "../db/tenant";
import { getJobQueue } from "../queue";
import { getWhatsAppProvider } from "../providers/registry";

/**
 * Appointment reminders — queued WhatsApp sends timed relative to
 * `appointments.scheduled_at`, never sent inline from the appointment-
 * creation request path (per the same "never block the main API" rule as
 * the campaign dialer).
 */

const REMINDER_QUEUE = "appointment-reminder";
const DEFAULT_REMINDER_LEAD_MINUTES = 60; // send 1h before, tenant-overridable via opts

export type ReminderJob = {
  orgId: string;
  appointmentId: string;
};

/** Enqueues a reminder job to fire `leadMinutes` before the appointment's
 * `scheduled_at` (or immediately if that time has already passed). Called
 * right after an appointment is created/rescheduled — never sends
 * anything itself. */
export async function scheduleAppointmentReminder(
  orgId: string,
  appointmentId: string,
  scheduledAt: Date,
  leadMinutes = DEFAULT_REMINDER_LEAD_MINUTES
): Promise<string> {
  const runAt = new Date(Math.max(Date.now(), scheduledAt.getTime() - leadMinutes * 60_000));
  return getJobQueue().enqueue<ReminderJob>(REMINDER_QUEUE, { orgId, appointmentId }, { orgId, runAt });
}

/** The job-queue handler: sends the actual WhatsApp reminder. Idempotent —
 * checks `reminder_sent_at` first so a redelivered/duplicate job never
 * double-sends. */
export async function processAppointmentReminderJob(job: ReminderJob): Promise<void> {
  // Every query here touches an RLS-enforced tenant table (appointments,
  // leads, whatsapp_messages), so it must run inside withTenant() — see
  // lib/campaigns/dialer.ts's top comment for why a plain pool.query()
  // against these tables would silently see/affect zero rows instead of
  // erroring.
  const appointment = await withTenant(job.orgId, null, async (client) => {
    const { rows } = await client.query(
      `SELECT a.id, a.type, a.scheduled_at, a.location_or_link, a.reminder_sent_at, a.status,
              l.phone_number
         FROM appointments a JOIN leads l ON l.id = a.lead_id
        WHERE a.id = $1 AND a.org_id = $2`,
      [job.appointmentId, job.orgId]
    );
    return rows[0];
  });

  if (!appointment || appointment.reminder_sent_at || appointment.status === "cancelled" || !appointment.phone_number) {
    return; // already sent, cancelled, or no number on file — nothing to do
  }

  const provider = await getWhatsAppProvider(job.orgId, null);
  const result = await provider.sendReminder({
    toNumber: appointment.phone_number,
    orgId: job.orgId,
    templateKey: "appointment_reminder", // tenant-configurable template, see docs/N8N_WORKFLOWS.md
    appointmentId: appointment.id,
    bodyContext: {
      type: appointment.type,
      scheduled_at: new Date(appointment.scheduled_at).toISOString(),
      location_or_link: appointment.location_or_link ?? "",
    },
  });

  await withTenant(job.orgId, null, async (client) => {
    await client.query(
      `INSERT INTO whatsapp_messages (org_id, appointment_id, provider_key, message_type, template_key, to_number, status, provider_message_id, payload)
       VALUES ($1, $2, $3, 'reminder', 'appointment_reminder', $4, $5, $6, $7)`,
      [job.orgId, appointment.id, provider.providerKey, appointment.phone_number, result.status, result.providerMessageId, JSON.stringify({})]
    );
    await client.query(`UPDATE appointments SET reminder_sent_at = now(), updated_at = now() WHERE id = $1`, [
      appointment.id,
    ]);
  });
}
