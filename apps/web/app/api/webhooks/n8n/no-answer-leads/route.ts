import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db/tenant";
import { assertValidN8nRequest, N8nAuthError } from "@/lib/webhooks/n8n-auth";

/**
 * GET /api/webhooks/n8n/no-answer-leads?orgId=... — "no-answer lead ->
 * follow-up automation" (n8n/workflows/no-answer-follow-up.json). Lists
 * campaign leads whose most recent disposition was no_answer/not
 * reachable and who haven't exhausted their smart-retry attempts, so an
 * n8n workflow can decide to nudge with a WhatsApp follow-up (via
 * /api/webhooks/n8n/qualified-lead-whatsapp, reused generically for any
 * templated follow-up send) alongside — not instead of — the built-in
 * smart-retry call schedule (lib/campaigns/dialer.ts).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await assertValidN8nRequest(req);
  } catch (err) {
    if (err instanceof N8nAuthError) return NextResponse.json({ error: err.message }, { status: 401 });
    throw err;
  }

  const { searchParams } = new URL(req.url);
  const orgId = searchParams.get("orgId");
  if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });

  const leads = await withTenant(orgId, null, async (client) => {
    const { rows } = await client.query(
      `SELECT cl.lead_id, cl.campaign_id, cl.attempts, l.phone_number, l.full_name
         FROM campaign_leads cl
         JOIN leads l ON l.id = cl.lead_id
        WHERE cl.org_id = $1 AND cl.last_disposition = 'no_answer' AND cl.status = 'pending'
        ORDER BY cl.updated_at DESC
        LIMIT 200`,
      [orgId]
    );
    return rows;
  });

  return NextResponse.json({ leads });
}
