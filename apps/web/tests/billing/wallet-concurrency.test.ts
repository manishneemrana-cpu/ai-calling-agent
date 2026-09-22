import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { applyWalletTransaction, InsufficientBalanceError } from "@/lib/billing/wallet";

/**
 * Phase 9 load-testing requirement: "write a targeted concurrency test for
 * the wallet deduction path specifically — many concurrent calls for the
 * same org should never let the balance go negative beyond what's
 * expected, i.e. no lost-update race condition."
 *
 * Fires 30 concurrent debits of ₹5 each against a wallet that starts at
 * ₹100 — only 20 of them can possibly succeed (20 * 5 = 100). Without
 * row-level locking in getOrCreateWallet() (see lib/billing/wallet.ts's
 * `FOR UPDATE` fix), two concurrent transactions can both read the SAME
 * starting balance and both believe their debit is affordable — a lost
 * update that drives the balance negative and lets more debits through
 * than the wallet can actually afford. This test proves that does NOT
 * happen: exactly 20 succeed, exactly 10 are rejected with
 * InsufficientBalanceError, and the final balance is exactly 0 — never
 * negative, never left over.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Wallet Concurrency Test Org ${suffix}`,
    `wallet-concurrency-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;
  await admin.query(`INSERT INTO wallets (org_id, balance) VALUES ($1, 100)`, [orgId]);
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

describe("wallet concurrent debit — no lost-update race condition", () => {
  it("allows exactly as many concurrent debits as the starting balance affords, never overdrafting", async () => {
    const attempts = 30;
    const debitAmount = 5;

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        applyWalletTransaction({
          orgId,
          type: "debit",
          reason: "call_charge",
          amount: debitAmount,
        })
      )
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(20); // floor(100 / 5)
    expect(failed).toHaveLength(10);
    for (const f of failed) {
      if (f.status === "rejected") {
        expect(f.reason).toBeInstanceOf(InsufficientBalanceError);
      }
    }

    const { rows } = await admin.query(`SELECT balance FROM wallets WHERE org_id = $1`, [orgId]);
    const finalBalance = Number(rows[0].balance);
    expect(finalBalance).toBeCloseTo(0, 5); // exactly drained, not negative, not left with slack
    expect(finalBalance).toBeGreaterThanOrEqual(0);

    const { rows: txRows } = await admin.query(
      `SELECT count(*)::int AS c FROM wallet_transactions WHERE org_id = $1 AND reason = 'call_charge'`,
      [orgId]
    );
    expect(txRows[0].c).toBe(20); // exactly one ledger row per successful debit, no duplicates/drift
  });
});
