import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withTenant } from "@/lib/db/tenant";
import { assertValidN8nRequest, N8nAuthError } from "@/lib/webhooks/n8n-auth";
import { getWhatsAppProvider, ProviderNotConfiguredError } from "@/lib/providers/registry";

/**
 * POST /api/webhooks/n8n/qualified-lead-whatsapp — "AI-qualified lead ->
 * WhatsApp" (n8n/workflows/ai-qualified-lead-to-whatsapp.json). n8n watches
 * for a lead reaching a "qualified" pipeline stage/disposition (Phase 5
 * CRM) and calls this endpoint to send a templated WhatsApp follow-up —
 * n8n never sends the message itself, it only triggers this app's own
 * WhatsApp Provider Registry (control-plane only, per the non-negotiable
 * n8n rule).
 */

const schema = z.object({
  orgId: z.string().uuid(),
  leadId: z.string().uuid(),
  toNumber: z.string().min(3),
  templateKey: z.string().min(1).default("qualified_lead_follow_up"),
  variables: z.record(z.string(), z.string()).optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    assertValidN8nRequest(req);
  } catch (err) {
    if (err instanceof N8nAuthError) return NextResponse.json({ error: err.message }, { status: 401 });
    throw err;
  }

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { orgId, leadId, toNumber, templateKey, variables } = parsed.data;

  try {
    const provider = await getWhatsAppProvider(orgId, null);
    const result = await provider.sendFollowUp({ orgId, leadId, toNumber, templateKey, variables });

    await withTenant(orgId, null, async (client) => {
      await client.query(
        `INSERT INTO whatsapp_messages (org_id, lead_id, provider_key, message_type, template_key, to_number, status, provider_message_id, payload)
         VALUES ($1, $2, $3, 'follow_up', $4, $5, $6, $7, $8)`,
        [orgId, leadId, provider.providerKey, templateKey, toNumber, result.status, result.providerMessageId, JSON.stringify(variables ?? {})]
      );
    });

    return NextResponse.json({ result }, { status: 201 });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
