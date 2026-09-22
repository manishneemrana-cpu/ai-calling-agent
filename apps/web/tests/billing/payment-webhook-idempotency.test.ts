import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { createWalletTopupOrder, handlePaymentWebhook } from "@/lib/billing/paymentOrders";
import { MockPaymentGatewayProvider } from "@/lib/providers/payment_gateway/adapters/mock";

/**
 * Proves the payment-gateway webhook idempotency guarantee required by
 * the spec: a retried webhook delivery must not double-credit the wallet.
 * Uses the Mock payment gateway adapter (no live keys), same
 * "testable-without-live-keys" pattern as every other provider layer.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;

beforeAll(async () => {
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY ??= "test-only-encryption-key-do-not-use-in-prod";
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Payment Webhook Test Org ${suffix}`,
    `payment-webhook-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;
  await admin.query(
    `INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
     VALUES ($1, 'payment_gateway', 'mock', true, 1, '{}'::jsonb)`,
    [orgId]
  );
  await admin.query(`INSERT INTO wallets (org_id, balance) VALUES ($1, 0)`, [orgId]);
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

async function verifyWithMock(headers: Record<string, string | string[] | undefined>, rawBody: string) {
  const provider = new MockPaymentGatewayProvider();
  return provider.verifyAndParseWebhook(headers, rawBody);
}

describe("payment webhook idempotency", () => {
  it("credits the wallet exactly once even when the same webhook is delivered twice", async () => {
    const order = await createWalletTopupOrder({ orgId, userId: null, amount: 500 });

    const rawBody = JSON.stringify({
      provider_order_id: order.providerOrderId,
      event_type: "payment.captured",
      status: "captured",
      idempotency_key: `evt_${randomUUID()}`, // same key both deliveries — a real gateway's own event id
    });

    const first = await handlePaymentWebhook({
      gatewayProviderKey: "mock",
      headers: {},
      rawBody,
      verify: verifyWithMock,
    });
    expect(first.wasNew).toBe(true);
    expect("balanceAfter" in first ? first.balanceAfter : undefined).toBeCloseTo(500);

    // Redelivery of the EXACT same webhook (same idempotency key).
    const second = await handlePaymentWebhook({
      gatewayProviderKey: "mock",
      headers: {},
      rawBody,
      verify: verifyWithMock,
    });
    expect(second.wasNew).toBe(false);

    const { rows: walletRows } = await admin.query(`SELECT balance FROM wallets WHERE org_id = $1`, [orgId]);
    expect(Number(walletRows[0].balance)).toBeCloseTo(500); // credited once, not 1000

    const { rows: txRows } = await admin.query(
      `SELECT count(*)::int AS c FROM wallet_transactions WHERE org_id = $1 AND reason = 'gateway_topup'`,
      [orgId]
    );
    expect(txRows[0].c).toBe(1); // exactly one ledger row, not two
  });

  it("does not credit anything for a non-captured event", async () => {
    const order = await createWalletTopupOrder({ orgId, userId: null, amount: 200 });
    const before = await admin.query(`SELECT balance FROM wallets WHERE org_id = $1`, [orgId]);

    const rawBody = JSON.stringify({
      provider_order_id: order.providerOrderId,
      event_type: "payment.failed",
      status: "failed",
    });
    const result = await handlePaymentWebhook({ gatewayProviderKey: "mock", headers: {}, rawBody, verify: verifyWithMock });
    expect(result.credited).toBe(false);

    const after = await admin.query(`SELECT balance FROM wallets WHERE org_id = $1`, [orgId]);
    expect(Number(after.rows[0].balance)).toBeCloseTo(Number(before.rows[0].balance));
  });
});
