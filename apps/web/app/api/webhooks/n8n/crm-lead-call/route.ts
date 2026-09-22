import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertValidN8nRequest, N8nAuthError } from "@/lib/webhooks/n8n-auth";
import { createOutboundCall, ComplianceBlockedError, ProviderNotConfiguredError } from "@/lib/calls/createCall";

/**
 * POST /api/webhooks/n8n/crm-lead-call — "CRM lead -> AI call"
 * (n8n/workflows/crm-lead-to-ai-call.json). Triggered when an n8n workflow
 * observes a CRM event (pipeline stage change, imported lead, etc.) and
 * decides an AI call should be placed for an EXISTING lead. Goes through
 * the same createOutboundCall() as every other path — compliance gate
 * always applies, an already-opted-out or DND lead is still blocked here.
 */

// `orgId`, if present in the body, is accepted for backward-compatible
// request shapes but is NEVER trusted for tenant selection — the org is
// always the one resolved from the per-tenant webhook token (see
// lib/webhooks/n8n-auth.ts's gap-closing-pass doc comment).
const schema = z.object({
  orgId: z.string().uuid().optional(),
  leadId: z.string().uuid(),
  toNumber: z.string().min(3),
  fromNumber: z.string().min(3),
  agentId: z.string().uuid().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  let orgId: string;
  try {
    orgId = await assertValidN8nRequest(req);
  } catch (err) {
    if (err instanceof N8nAuthError) return NextResponse.json({ error: err.message }, { status: 401 });
    throw err;
  }

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { leadId, toNumber, fromNumber, agentId } = parsed.data;

  try {
    const { call } = await createOutboundCall({ orgId, userId: null, toNumber, fromNumber, agentId, leadId });
    return NextResponse.json({ call }, { status: 201 });
  } catch (err) {
    if (err instanceof ComplianceBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
