import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withTenant } from "@/lib/db/tenant";
import { assertValidSitesnsignRequest, SitesnsignAuthError } from "@/lib/webhooks/sitesnsignAuth";
import { createOutboundCall, ComplianceBlockedError, ProviderNotConfiguredError } from "@/lib/calls/createCall";

/**
 * POST /api/webhooks/sitesnsign/lead-intake — sitesnsign.com's NestJS
 * backend calls this whenever a new lead lands in its own CRM `leads`
 * table (the founder's Google Sheet structure: Date, Buyer Name, Phone,
 * Source, Stage, Broker, Listing ID, Requirement). See
 * docs/SITESNSIGN_INTEGRATION.md for the full contract this implements —
 * this file is the RECEIVING side; the sending side lives in a codebase
 * this task has no access to (out of scope, documented as a spec there).
 *
 * Auth: lib/webhooks/sitesnsignAuth.ts's per-tenant token + HMAC body
 * signature (both required). The founder's own org is the only tenant
 * expected to configure this integration, but the code below is generic —
 * any org could receive a `sitesnsign_webhook_tokens` row.
 *
 * The actual "auto-call" behavior: on a valid, non-duplicate lead, this
 * creates the `leads` row (Phase 5 schema) then calls the SAME
 * `createOutboundCall()` every other call-creation path in this codebase
 * uses — the compliance gate (consent/DND/opt-out/hours) and the wallet
 * balance gate both still apply; there is no bypass for this integration.
 */

const payloadSchema = z.object({
  externalLeadId: z.string().min(1), // sitesnsign.com's own leads.id — used for idempotency
  date: z.string().optional(), // ISO date string; informational only, created_at is authoritative
  buyerName: z.string().optional(),
  phone: z.string().min(3),
  source: z.string().optional(),
  stage: z.string().optional(),
  broker: z.string().optional(),
  listingId: z.string().optional(),
  requirement: z.string().optional(),
  agentId: z.string().uuid().optional(),
  fromNumber: z.string().min(3).optional(),
  triggerCall: z.boolean().default(true),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();

  let orgId: string;
  try {
    orgId = await assertValidSitesnsignRequest(req, rawBody);
  } catch (err) {
    if (err instanceof SitesnsignAuthError) return NextResponse.json({ error: err.message }, { status: 401 });
    throw err;
  }

  const json = (() => {
    try {
      return JSON.parse(rawBody);
    } catch {
      return null;
    }
  })();
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { externalLeadId, buyerName, phone, source, stage, broker, listingId, requirement, agentId, fromNumber, triggerCall } =
    parsed.data;

  const { lead, alreadyExisted } = await withTenant(orgId, null, async (client) => {
    // Idempotency: a retried delivery of the same sitesnsign.com lead must
    // not create a second `leads` row or place a second call. Keyed on
    // (org_id, custom_fields->>'sitesnsign_external_lead_id') — see
    // docs/SITESNSIGN_INTEGRATION.md's "Retry/idempotency" section.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM leads WHERE org_id = $1 AND custom_fields->>'sitesnsign_external_lead_id' = $2 LIMIT 1`,
      [orgId, externalLeadId]
    );
    if (existing.rows[0]) {
      return { lead: { id: existing.rows[0].id }, alreadyExisted: true };
    }

    const customFields = {
      sitesnsign_external_lead_id: externalLeadId,
      source: source ?? null,
      stage: stage ?? null,
      broker: broker ?? null,
      listing_id: listingId ?? null,
      requirement: requirement ?? null,
    };
    const { rows } = await client.query(
      `INSERT INTO leads (org_id, agent_id, full_name, phone_number, custom_fields)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, agentId ?? null, buyerName ?? null, phone, JSON.stringify(customFields)]
    );
    const leadId = rows[0].id as string;

    // sitesnsign.com's own CRM leads are treated as inbound-relationship
    // consent (the buyer already engaged the founder's real-estate site),
    // same 7-day explicit-consent window as the existing n8n web-form
    // intake path (docs/COMPLIANCE.md) — never assumed indefinite. BUT an
    // existing do-not-call flag for this SAME phone number (any prior lead
    // under this org) is never silently overridden just because a fresh
    // CRM lead came in for it — the compliance gate must still block this
    // lead's call the same way it would block any other, so a
    // previously-recorded opt-out is carried forward instead of a blanket
    // 'granted' being (re-)inserted for the same number.
    const priorOptOut = await client.query<{ opted_out: boolean }>(
      `SELECT bool_or(lc.opted_out) AS opted_out
         FROM lead_compliance lc JOIN leads l ON l.id = lc.lead_id
        WHERE l.org_id = $1 AND l.phone_number = $2`,
      [orgId, phone]
    );
    if (priorOptOut.rows[0]?.opted_out) {
      await client.query(
        `INSERT INTO lead_compliance (org_id, lead_id, consent_status, consent_source, opted_out, opted_out_at)
         VALUES ($1, $2, 'revoked', 'sitesnsign_crm', true, now())`,
        [orgId, leadId]
      );
    } else {
      await client.query(
        `INSERT INTO lead_compliance (org_id, lead_id, consent_status, consent_source, consent_captured_at, consent_expires_at)
         VALUES ($1, $2, 'granted', 'sitesnsign_crm', now(), now() + interval '7 days')`,
        [orgId, leadId]
      );
    }
    return { lead: { id: leadId }, alreadyExisted: false };
  });

  if (alreadyExisted || !triggerCall) {
    return NextResponse.json({ lead, alreadyExisted }, { status: alreadyExisted ? 200 : 201 });
  }

  try {
    const { call } = await createOutboundCall({
      orgId,
      userId: null,
      toNumber: phone,
      fromNumber: fromNumber ?? "sitesnsign-lead-default",
      agentId,
      leadId: lead.id,
    });
    return NextResponse.json({ lead, call }, { status: 201 });
  } catch (err) {
    // Lead creation already succeeded — a blocked/misconfigured call is
    // reported but doesn't roll back the lead (same behavior as the n8n
    // web-form lead-intake path this mirrors).
    if (err instanceof ComplianceBlockedError) {
      return NextResponse.json({ lead, callBlocked: err.message }, { status: 201 });
    }
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ lead, callBlocked: err.message }, { status: 201 });
    }
    throw err;
  }
}
