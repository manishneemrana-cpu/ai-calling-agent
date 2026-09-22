import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import { scheduleAppointmentReminder } from "@/lib/appointments/reminders";

/**
 * Minimal appointments CRUD (Phase 6 plumbing-proof, matching Phase 1/5's
 * austerity level). `type` is free text — tenant-configurable (site_visit,
 * demo, consultation, pickup, ...), never a fixed enum, per the
 * multi-industry "generalize site visits" pivot.
 */

const createAppointmentSchema = z.object({
  leadId: z.string().uuid(),
  callId: z.string().uuid().optional(),
  type: z.string().min(1).default("appointment"),
  scheduledAt: z.string().datetime(),
  locationOrLink: z.string().optional(),
  notes: z.string().optional(),
  reminderLeadMinutes: z.number().int().min(0).optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = createAppointmentSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { leadId, callId, type, scheduledAt, locationOrLink, notes, reminderLeadMinutes } = parsed.data;

  const appointment = await withTenant(session.orgId, session.userId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO appointments (org_id, lead_id, call_id, type, scheduled_at, location_or_link, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, type, scheduled_at, status, location_or_link, notes`,
      [session.orgId, leadId, callId ?? null, type, scheduledAt, locationOrLink ?? null, notes ?? null]
    );
    return rows[0];
  });

  await scheduleAppointmentReminder(session.orgId, appointment.id, new Date(scheduledAt), reminderLeadMinutes);

  return NextResponse.json({ appointment }, { status: 201 });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 200);

  const appointments = await withTenant(session.orgId, session.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, lead_id, type, scheduled_at, status, location_or_link, reminder_sent_at, created_at
         FROM appointments WHERE org_id = $1 ORDER BY scheduled_at ASC LIMIT $2`,
      [session.orgId, limit]
    );
    return rows;
  });

  return NextResponse.json({ appointments });
}
