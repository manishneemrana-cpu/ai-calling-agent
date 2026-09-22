import { withTenant, withoutTenant } from "../db/tenant";
import { getPaymentGatewayProvider } from "../providers/registry";

/**
 * Wallet top-up via the payment-gateway Provider Registry layer. Creating
 * the order is tenant-scoped (normal withTenant). Handling the resulting
 * webhook is NOT — a webhook arrives with no session/org context, exactly
 * like Phase 2's telephony webhooks, so it goes through the same
 * `withoutTenant` + SECURITY DEFINER SQL-function pattern as
 * `process_telephony_webhook_event` (007_provider_registry.sql): here,
 * `credit_wallet_from_payment` (012_phase7_billing.sql), which atomically
 * records the idempotency ledger row + credits the wallet in one
 * transaction, so a retried delivery credits at most once.
 */

export type CreateWalletTopupOrderParams = {
  orgId: string;
  userId: string | null;
  amount: number;
  currency?: string;
  gatewayProviderKey?: string;
  callbackUrl?: string;
};

export async function createWalletTopupOrder(params: CreateWalletTopupOrderParams) {
  return withTenant(params.orgId, params.userId, async (client) => {
    const provider = await getPaymentGatewayProvider(params.orgId, params.userId, {
      providerKey: params.gatewayProviderKey,
    });
    const link = await provider.createPaymentLink({
      orgId: params.orgId,
      amount: params.amount,
      currency: params.currency ?? "INR",
      description: "Wallet top-up",
      callbackUrl: params.callbackUrl,
    });
    const { rows } = await client.query(
      `INSERT INTO payment_orders (org_id, gateway_provider_key, provider_order_id, purpose, amount, currency)
       VALUES ($1, $2, $3, 'wallet_topup', $4, $5)
       RETURNING id`,
      [params.orgId, provider.providerKey, link.providerOrderId, params.amount, params.currency ?? "INR"]
    );
    return { paymentOrderId: rows[0].id, paymentUrl: link.paymentUrl, providerOrderId: link.providerOrderId };
  });
}

export type HandlePaymentWebhookParams = {
  gatewayProviderKey: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  /** Injectable for tests; in production this is resolved via a
   * platform-level (org-less) instantiation of the gateway adapter — the
   * webhook signature is verified with the PLATFORM's own gateway
   * webhook secret (one gateway account per platform deployment in Phase
   * 7's single-tenant-billing scope; see docs/STACK_PROPOSAL.md's Phase 8
   * extension note for multi-account reseller billing). */
  verify: (
    headers: Record<string, string | string[] | undefined>,
    rawBody: string
  ) => Promise<{ idempotencyKey: string; providerOrderId: string; eventType: string; isPaymentCaptured: boolean; amount: number }>;
};

export async function handlePaymentWebhook(params: HandlePaymentWebhookParams) {
  const event = await params.verify(params.headers, params.rawBody);

  if (!event.isPaymentCaptured) {
    return { credited: false, wasNew: false };
  }

  return withoutTenant(async (client) => {
    // `credit_wallet_from_payment` is the ONLY thing that touches
    // payment_orders/wallets here — it is SECURITY DEFINER (like
    // process_telephony_webhook_event) precisely so it can look up which
    // org a provider_order_id belongs to and read that order's OWN
    // recorded amount itself, since this request (a webhook) has no
    // tenant context to trust and the webhook payload's own amount field
    // must never be trusted as the authoritative charge amount.
    const result = await client.query(
      `SELECT was_new, wallet_id, balance_after FROM credit_wallet_from_payment($1, $2, $3, $4, $5)`,
      [
        params.gatewayProviderKey,
        event.idempotencyKey,
        event.providerOrderId,
        event.eventType,
        JSON.stringify({ eventType: event.eventType }),
      ]
    );
    const row = result.rows[0];
    if (!row.wallet_id) {
      return { credited: false, wasNew: false }; // no matching payment_orders row
    }
    return { credited: row.was_new, wasNew: row.was_new, walletId: row.wallet_id, balanceAfter: Number(row.balance_after) };
  });
}
