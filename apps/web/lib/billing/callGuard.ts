import type { PoolClient } from "pg";

/**
 * The mandatory pre-dial wallet-balance check — Phase 7's addition to the
 * SAME structurally-impossible-to-bypass gate `lib/compliance/gate.ts`
 * lives in. This module is called from `createOutboundCall()`
 * (lib/calls/createCall.ts) immediately after the compliance gate and
 * BEFORE the telephony provider is resolved, so there is no code path
 * that places a call without going through both checks — see
 * apps/web/tests/billing/zero-balance-blocking.test.ts for the "every
 * known call-creation path is blocked" proof, mirroring
 * apps/web/tests/compliance/gate.test.ts's standard.
 *
 * Gating rule: an org is wallet-gated ONLY when it has a `billing_accounts`
 * row whose plan is `prepaid_wallet` (or `hybrid`, which includes a wallet
 * component) — in that case, a balance <= 0 blocks the call. An org with
 * no billing_accounts row at all, or on `subscription` / `pay_as_you_go` /
 * `postpaid_enterprise`, is not wallet-gated by this check (a
 * subscription/postpaid tenant's billing is enforced elsewhere — e.g.
 * subscription-expiry/credit-limit checks are a natural extension of this
 * same module, not implemented in Phase 7's scope). This keeps existing
 * tenants with no billing setup yet (e.g. every pre-Phase-7 test org)
 * unaffected, while making the wallet check impossible to skip for any
 * tenant that IS on a wallet plan.
 */

export class ZeroBalanceBlockedError extends Error {
  constructor(public readonly orgId: string, public readonly balance: number) {
    super(`Outbound call blocked: org ${orgId} is on a prepaid wallet plan with balance ${balance} <= 0`);
    this.name = "ZeroBalanceBlockedError";
  }
}

export async function assertWalletHasBalance(client: PoolClient, orgId: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT bp.plan_type
       FROM billing_accounts ba
       JOIN billing_plans bp ON bp.id = ba.plan_id
      WHERE ba.org_id = $1 AND ba.status = 'active'`,
    [orgId]
  );
  const planType: string | undefined = rows[0]?.plan_type;
  const isWalletGated = planType === "prepaid_wallet" || planType === "hybrid";
  if (!isWalletGated) {
    return;
  }

  const walletRows = await client.query(`SELECT balance FROM wallets WHERE org_id = $1`, [orgId]);
  const balance = walletRows.rows[0] ? Number(walletRows.rows[0].balance) : 0;
  if (balance <= 0) {
    await client.query(
      `INSERT INTO billing_alerts (org_id, alert_type, details) VALUES ($1, 'call_blocked', $2)`,
      [orgId, JSON.stringify({ balance })]
    );
    throw new ZeroBalanceBlockedError(orgId, balance);
  }
}
