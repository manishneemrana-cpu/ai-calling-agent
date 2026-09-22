import type { PoolClient } from "pg";
import { withTenant } from "../db/tenant";

/**
 * Wallet ledger discipline (Phase 7): a wallet's `balance` column is NEVER
 * written directly by any other module in this codebase. Every change goes
 * through `applyWalletTransaction()`, which inserts the
 * `wallet_transactions` ledger row and updates `wallets.balance` in the
 * SAME database transaction — so the ledger and the balance can never
 * drift apart. Gateway-webhook credits use the separate
 * `credit_wallet_from_payment()` SECURITY DEFINER SQL function
 * (db/migrations/012_phase7_billing.sql) instead, for its idempotency
 * guarantee across an unauthenticated webhook request; this function is
 * for authenticated, tenant-scoped debits/credits (call charges, manual
 * top-ups, refunds, adjustments).
 */

export type WalletTransactionReason = "call_charge" | "manual_topup" | "refund" | "adjustment";

export type ApplyWalletTransactionParams = {
  orgId: string;
  type: "credit" | "debit";
  reason: WalletTransactionReason;
  amount: number;
  costRecordId?: string | null;
  invoiceId?: string | null;
  idempotencyKey?: string | null;
  notes?: string | null;
};

export type WalletState = {
  id: string;
  balance: number;
  currency: string;
  lowBalanceThreshold: number;
};

export async function getOrCreateWallet(client: PoolClient, orgId: string): Promise<WalletState> {
  const existing = await client.query(
    `SELECT id, balance, currency, low_balance_threshold FROM wallets WHERE org_id = $1`,
    [orgId]
  );
  if (existing.rows[0]) {
    return {
      id: existing.rows[0].id,
      balance: Number(existing.rows[0].balance),
      currency: existing.rows[0].currency,
      lowBalanceThreshold: Number(existing.rows[0].low_balance_threshold),
    };
  }
  const created = await client.query(
    `INSERT INTO wallets (org_id) VALUES ($1) RETURNING id, balance, currency, low_balance_threshold`,
    [orgId]
  );
  return {
    id: created.rows[0].id,
    balance: Number(created.rows[0].balance),
    currency: created.rows[0].currency,
    lowBalanceThreshold: Number(created.rows[0].low_balance_threshold),
  };
}

/**
 * Applies one ledger entry + balance update, inside `withTenant`'s
 * transaction. A debit that would take the balance below zero is refused
 * (throws InsufficientBalanceError) — callers that need to *allow*
 * negative balances (postpaid/enterprise) must not call this for that
 * plan type; see lib/billing/callGuard.ts for how plan type decides
 * whether a debit is even attempted.
 */
export class InsufficientBalanceError extends Error {
  constructor(orgId: string) {
    super(`Wallet balance insufficient for org ${orgId}`);
    this.name = "InsufficientBalanceError";
  }
}

export async function applyWalletTransaction(
  params: ApplyWalletTransactionParams
): Promise<{ walletId: string; balanceAfter: number; alertTriggered: "low_balance" | "zero_balance" | null }> {
  return withTenant(params.orgId, null, async (client) => {
    const wallet = await getOrCreateWallet(client, params.orgId);
    const delta = params.type === "credit" ? params.amount : -params.amount;
    const balanceAfter = wallet.balance + delta;

    if (params.type === "debit" && balanceAfter < 0) {
      throw new InsufficientBalanceError(params.orgId);
    }

    if (params.idempotencyKey) {
      const dup = await client.query(
        `SELECT id FROM wallet_transactions WHERE wallet_id = $1 AND idempotency_key = $2`,
        [wallet.id, params.idempotencyKey]
      );
      if (dup.rows[0]) {
        return { walletId: wallet.id, balanceAfter: wallet.balance, alertTriggered: null };
      }
    }

    await client.query(`UPDATE wallets SET balance = $2, updated_at = now() WHERE id = $1`, [
      wallet.id,
      balanceAfter,
    ]);

    await client.query(
      `INSERT INTO wallet_transactions
         (org_id, wallet_id, type, reason, amount, balance_after, cost_record_id, invoice_id, idempotency_key, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        params.orgId,
        wallet.id,
        params.type,
        params.reason,
        params.amount,
        balanceAfter,
        params.costRecordId ?? null,
        params.invoiceId ?? null,
        params.idempotencyKey ?? null,
        params.notes ?? null,
      ]
    );

    let alertTriggered: "low_balance" | "zero_balance" | null = null;
    if (balanceAfter <= 0) {
      alertTriggered = "zero_balance";
    } else if (balanceAfter <= wallet.lowBalanceThreshold) {
      alertTriggered = "low_balance";
    }
    if (alertTriggered) {
      await client.query(
        `INSERT INTO billing_alerts (org_id, alert_type, details) VALUES ($1, $2, $3)`,
        [params.orgId, alertTriggered, JSON.stringify({ balance_after: balanceAfter })]
      );
    }

    return { walletId: wallet.id, balanceAfter, alertTriggered };
  });
}

/** Read-only check used by the call-blocking guard; does not mutate anything. */
export async function getWalletBalance(client: PoolClient, orgId: string): Promise<number> {
  const { rows } = await client.query(`SELECT balance FROM wallets WHERE org_id = $1`, [orgId]);
  return rows[0] ? Number(rows[0].balance) : 0;
}
