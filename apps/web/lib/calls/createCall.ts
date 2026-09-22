import { randomUUID } from "crypto";
import { withTenant } from "../db/tenant";
import { getTelephonyProvider, ProviderNotConfiguredError } from "../providers/registry";
import { assertCallIsCompliant, ComplianceBlockedError } from "../compliance/gate";
import { assertWalletHasBalance, ZeroBalanceBlockedError } from "../billing/callGuard";
import type { CreateCallResult } from "../providers/telephony/types";

export { ComplianceBlockedError, ProviderNotConfiguredError, ZeroBalanceBlockedError };

export type CreateOutboundCallParams = {
  orgId: string;
  userId: string | null;
  toNumber: string;
  fromNumber: string;
  agentId?: string | null;
  leadId?: string | null;
  campaignId?: string | null;
  providerKey?: string;
};

export type CreateOutboundCallOutcome = {
  call: { id: string; status: string; provider_call_id: string };
  providerResult: CreateCallResult;
};

/**
 * createOutboundCall — the ONE function in this codebase that is allowed
 * to place a real outbound call. Every call-creation path (the
 * direct/manual `POST /api/calls` route and the Phase 6 campaign dialer
 * job — see lib/campaigns/dialer.ts) calls this and nothing else; there is
 * no lower-level "place a call" helper that skips the gate.
 *
 * The compliance gate (lib/compliance/gate.ts) and the Phase 7 wallet-
 * balance gate (lib/billing/callGuard.ts) both run FIRST, inside the same
 * withTenant() transaction, before the telephony provider is even
 * resolved — a caller cannot construct a call by going around this
 * function, and this function cannot construct a call without first
 * passing both gates. See apps/web/tests/compliance/gate.test.ts and
 * apps/web/tests/billing/zero-balance-blocking.test.ts for the "every
 * known call-creation path is blocked" proofs.
 */
export async function createOutboundCall(params: CreateOutboundCallParams): Promise<CreateOutboundCallOutcome> {
  const appCallId = randomUUID();

  return withTenant(params.orgId, params.userId, async (client) => {
    // 1) MANDATORY compliance gate. Throws ComplianceBlockedError and
    // stops here — no provider is ever contacted — if this call must not
    // be placed.
    await assertCallIsCompliant(client, {
      orgId: params.orgId,
      leadId: params.leadId ?? null,
      toNumber: params.toNumber,
      campaignId: params.campaignId ?? null,
    });

    // 1b) MANDATORY zero-balance gate (Phase 7). Throws
    // ZeroBalanceBlockedError and stops here for a prepaid_wallet/hybrid
    // tenant with balance <= 0 — same "no provider contacted" guarantee.
    await assertWalletHasBalance(client, params.orgId);

    // 2) Only now does the telephony provider get resolved/invoked. Reuses
    // THIS transaction's own client (Phase 9 concurrency fix — see
    // registry.ts's getProvider doc comment) instead of opening a second,
    // nested connection from the pool, which deadlocks under concurrent
    // load >= the pool's max size.
    const provider = await getTelephonyProvider(params.orgId, params.userId, {
      providerKey: params.providerKey,
      client,
    });
    const providerResult = await provider.createCall({
      toNumber: params.toNumber,
      fromNumber: params.fromNumber,
      orgId: params.orgId,
      appCallId,
    });

    const { rows } = await client.query(
      `INSERT INTO calls (id, org_id, agent_id, lead_id, direction, status, from_number, to_number, provider_call_id)
       VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, $8)
       RETURNING id, status, provider_call_id`,
      [
        appCallId,
        params.orgId,
        params.agentId ?? null,
        params.leadId ?? null,
        providerResult.status,
        params.fromNumber,
        params.toNumber,
        providerResult.providerCallId,
      ]
    );

    if (params.campaignId && params.leadId) {
      await client.query(
        `UPDATE campaign_leads
            SET status = 'in_progress', attempts = attempts + 1, last_call_id = $3, updated_at = now()
          WHERE org_id = $1 AND campaign_id = $2 AND lead_id = $4`,
        [params.orgId, params.campaignId, appCallId, params.leadId]
      );
    }

    return { call: rows[0], providerResult };
  });
}
