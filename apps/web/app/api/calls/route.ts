import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import {
  createOutboundCall,
  ComplianceBlockedError,
  ProviderNotConfiguredError,
  ZeroBalanceBlockedError,
} from "@/lib/calls/createCall";

/**
 * POST /api/calls — places an outbound call using this tenant's configured
 * default telephony provider (resolved via the Provider Registry — see
 * lib/providers/registry.ts and docs/PROVIDER_REGISTRY.md). Business logic
 * here never knows or cares whether that ends up being Mock, Plivo, or
 * FreJun Teler.
 *
 * In tests/demo mode (no tenant_provider_config row beyond the seeded
 * 'mock' default), this always resolves to MockTelephonyProvider — no real
 * telephony credentials are required for the app to function end-to-end.
 *
 * Phase 6: this route is a thin wrapper over lib/calls/createCall.ts's
 * `createOutboundCall()` — the ONE function allowed to place a call — so
 * the mandatory pre-dial compliance gate (lib/compliance/gate.ts) runs
 * here exactly the same way it runs for the campaign dialer. This route
 * never talks to a telephony provider or inserts into `calls` directly.
 */

const createCallSchema = z.object({
  toNumber: z.string().min(3),
  fromNumber: z.string().min(3),
  agentId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  /** Optional explicit override, e.g. for an admin test-call UI; normally
   * omitted so the tenant's default provider (is_default/priority) is used. */
  providerKey: z.string().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = createCallSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { toNumber, fromNumber, agentId, leadId, providerKey } = parsed.data;

  try {
    const { call } = await createOutboundCall({
      orgId: session.orgId,
      userId: session.userId,
      toNumber,
      fromNumber,
      agentId,
      leadId,
      providerKey,
    });

    return NextResponse.json({ call }, { status: 201 });
  } catch (err) {
    if (err instanceof ComplianceBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ZeroBalanceBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 402 });
    }
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Failed to place call";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 200);

  const calls = await withTenant(session.orgId, session.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, status, from_number, to_number, provider_call_id, created_at
         FROM calls WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [session.orgId, limit]
    );
    return rows;
  });

  return NextResponse.json({ calls });
}
