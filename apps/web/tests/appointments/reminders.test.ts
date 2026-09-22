import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { scheduleAppointmentReminder, processAppointmentReminderJob } from "@/lib/appointments/reminders";
import { MockWhatsAppProvider } from "@/lib/providers/whatsapp/adapters/mock";

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;
let leadId: string;
let appointmentId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Appointments Test Org ${suffix}`,
    `appointments-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;

  await admin.query(
    `INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
     VALUES ($1, 'whatsapp', 'mock', true, 1, '{}'::jsonb)`,
    [orgId]
  );

  const leadRow = await admin.query(
    "INSERT INTO leads (org_id, full_name, phone_number) VALUES ($1, 'Appt Lead', '+919876500000') RETURNING id",
    [orgId]
  );
  leadId = leadRow.rows[0].id;

  const apptRow = await admin.query(
    `INSERT INTO appointments (org_id, lead_id, type, scheduled_at, location_or_link)
     VALUES ($1, $2, 'site_visit', now() + interval '2 hours', 'https://maps.example.com/x') RETURNING id`,
    [orgId, leadId]
  );
  appointmentId = apptRow.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

describe("Appointment reminders", () => {
  it("enqueues a reminder job runnable ahead of the appointment time", async () => {
    const jobId = await scheduleAppointmentReminder(orgId, appointmentId, new Date(Date.now() + 2 * 3600_000), 60);
    expect(jobId).toBeTruthy();
    const { rows } = await admin.query("SELECT queue_name, run_at FROM job_queue WHERE id = $1", [jobId]);
    expect(rows[0].queue_name).toBe("appointment-reminder");
    expect(new Date(rows[0].run_at).getTime()).toBeLessThan(Date.now() + 2 * 3600_000);
  });

  it("processAppointmentReminderJob sends via the WhatsApp registry and marks reminder_sent_at (idempotent on redelivery)", async () => {
    MockWhatsAppProvider._resetForTests();

    await processAppointmentReminderJob({ orgId, appointmentId });

    const sent = MockWhatsAppProvider._sentForTests();
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("sendReminder");
    expect(sent[0].toNumber).toBe("+919876500000");

    const { rows } = await admin.query("SELECT reminder_sent_at FROM appointments WHERE id = $1", [appointmentId]);
    expect(rows[0].reminder_sent_at).not.toBeNull();

    const { rows: waRows } = await admin.query(
      "SELECT count(*)::int AS c FROM whatsapp_messages WHERE appointment_id = $1",
      [appointmentId]
    );
    expect(waRows[0].c).toBe(1);

    // Redelivery of the same job must NOT send a second message.
    await processAppointmentReminderJob({ orgId, appointmentId });
    expect(MockWhatsAppProvider._sentForTests()).toHaveLength(1);
  });
});
