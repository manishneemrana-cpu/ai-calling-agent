import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db/tenant";
import { assertValidN8nRequest, N8nAuthError } from "@/lib/webhooks/n8n-auth";

/**
 * GET /api/webhooks/n8n/due-appointments?orgId=...&withinHours=24 —
 * "site-visit/appointment -> reminder" (n8n/workflows/appointment-reminder-failsafe.json).
 *
 * This app already schedules and sends appointment reminders itself via
 * the job queue (lib/appointments/reminders.ts) the moment an appointment
 * is created — this n8n workflow is a documented FAILSAFE cross-check
 * (per docs/N8N_WORKFLOWS.md's manual smoke-test checklist), polling for
 * any appointment within the window whose reminder was never marked sent,
 * so ops can be alerted if the internal queue ever misses one. It reads
 * only; it never sends anything itself (n8n stays control-plane only).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    assertValidN8nRequest(req);
  } catch (err) {
    if (err instanceof N8nAuthError) return NextResponse.json({ error: err.message }, { status: 401 });
    throw err;
  }

  const { searchParams } = new URL(req.url);
  const orgId = searchParams.get("orgId");
  if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });
  const withinHours = Math.min(Number(searchParams.get("withinHours") ?? "24"), 168);

  const appointments = await withTenant(orgId, null, async (client) => {
    const { rows } = await client.query(
      `SELECT a.id, a.type, a.scheduled_at, a.status, l.phone_number
         FROM appointments a JOIN leads l ON l.id = a.lead_id
        WHERE a.org_id = $1 AND a.reminder_sent_at IS NULL AND a.status NOT IN ('cancelled', 'completed')
          AND a.scheduled_at BETWEEN now() AND now() + ($2 || ' hours')::interval
        ORDER BY a.scheduled_at ASC`,
      [orgId, String(withinHours)]
    );
    return rows;
  });

  return NextResponse.json({ appointments });
}
