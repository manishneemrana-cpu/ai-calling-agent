import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withTenant } from "@/lib/db/tenant";
import { assertValidN8nRequest, N8nAuthError } from "@/lib/webhooks/n8n-auth";
import { createOutboundCall, ComplianceBlockedError, ProviderNotConfiguredError } from "@/lib/calls/createCall";

/**
 * POST /api/webhooks/n8n/lead-intake — "Website form -> create lead -> AI
 * call" (n8n/workflows/website-form-to-ai-call.json). n8n receives the raw
 * form submission (its own webhook trigger) and forwards a normalized
 * payload here; this endpoint owns creating the lead + consent record and
 * (optionally) placing the first call — through the SAME
 * createOutboundCall() as every other call path, so the compliance gate
 * still applies even to a fresh web-form lead.
 *
 * A website form submission is treated as `consent_source: 'web_form'`,
 * `consent_status: 'granted'` with a 7-day expiry (see docs/COMPLIANCE.md
 * — explicit consent for a specific transaction is valid 7 days), never
 * assumed to be indefinite consent.
 */

const schema = z.object({
  orgId: z.string().uuid(),
  fullName: z.string().optional(),
  phoneNumber: z.string().min(3),
  email: z.string().email().optional(),
  agentId: z.string().uuid().optional(),
  fromNumber: z.string().min(3).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  triggerCall: z.boolean().default(true),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await assertValidN8nRequest(req);
  } catch (err) {
    if (err instanceof N8nAuthError) return NextResponse.json({ error: err.message }, { status: 401 });
    throw err;
  }

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { orgId, fullName, phoneNumber, email, agentId, fromNumber, customFields, triggerCall } = parsed.data;

  const lead = await withTenant(orgId, null, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO leads (org_id, agent_id, full_name, phone_number, email, custom_fields)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [orgId, agentId ?? null, fullName ?? null, phoneNumber, email ?? null, JSON.stringify(customFields ?? {})]
    );
    const leadId = rows[0].id as string;
    await client.query(
      `INSERT INTO lead_compliance (org_id, lead_id, consent_status, consent_source, consent_captured_at, consent_expires_at)
       VALUES ($1, $2, 'granted', 'web_form', now(), now() + interval '7 days')`,
      [orgId, leadId]
    );
    return { id: leadId };
  });

  if (!triggerCall) {
    return NextResponse.json({ lead }, { status: 201 });
  }

  try {
    const { call } = await createOutboundCall({
      orgId,
      userId: null,
      toNumber: phoneNumber,
      fromNumber: fromNumber ?? "web-lead-default",
      agentId,
      leadId: lead.id,
    });
    return NextResponse.json({ lead, call }, { status: 201 });
  } catch (err) {
    // Lead creation already succeeded — a blocked/misconfigured call is
    // reported but doesn't roll back the lead.
    if (err instanceof ComplianceBlockedError) {
      return NextResponse.json({ lead, callBlocked: err.message }, { status: 201 });
    }
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ lead, callBlocked: err.message }, { status: 201 });
    }
    throw err;
  }
}
