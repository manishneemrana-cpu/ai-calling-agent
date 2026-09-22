import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db/tenant";
import { assertValidN8nRequest, N8nAuthError } from "@/lib/webhooks/n8n-auth";

/**
 * GET /api/webhooks/n8n/daily-summary?orgId=... — "daily summary to owner"
 * (n8n/workflows/daily-summary-to-owner.json). Returns the day's counts;
 * n8n's own Email/Slack node (not part of this app) formats and sends it —
 * this endpoint never sends anything itself.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  // The org is resolved from the per-tenant webhook token, never from the
  // `?orgId=` query param (see lib/webhooks/n8n-auth.ts's gap-closing-pass
  // doc comment) — a `?orgId=` on the URL is accepted-but-ignored for
  // backward-compatible request shapes only.
  let orgId: string;
  try {
    orgId = await assertValidN8nRequest(req);
  } catch (err) {
    if (err instanceof N8nAuthError) return NextResponse.json({ error: err.message }, { status: 401 });
    throw err;
  }

  const summary = await withTenant(orgId, null, async (client) => {
    // Sequential, not Promise.all: a single pg Client cannot pipeline
    // concurrent queries safely (see node-postgres's own deprecation
    // warning against it) — withTenant() hands us one Client per call.
    const calls = await client.query(
      `SELECT count(*)::int AS c, count(*) FILTER (WHERE status = 'completed')::int AS completed
         FROM calls WHERE org_id = $1 AND created_at >= current_date`,
      [orgId]
    );
    const appointments = await client.query(
      `SELECT count(*)::int AS c FROM appointments WHERE org_id = $1 AND scheduled_at::date = current_date`,
      [orgId]
    );
    const leads = await client.query(`SELECT count(*)::int AS c FROM leads WHERE org_id = $1 AND created_at >= current_date`, [
      orgId,
    ]);
    const whatsapp = await client.query(
      `SELECT count(*)::int AS c FROM whatsapp_messages WHERE org_id = $1 AND created_at >= current_date`,
      [orgId]
    );
    return {
      date: new Date().toISOString().slice(0, 10),
      callsToday: calls.rows[0].c,
      callsCompleted: calls.rows[0].completed,
      appointmentsToday: appointments.rows[0].c,
      newLeadsToday: leads.rows[0].c,
      whatsappMessagesToday: whatsapp.rows[0].c,
    };
  });

  return NextResponse.json({ summary });
}
