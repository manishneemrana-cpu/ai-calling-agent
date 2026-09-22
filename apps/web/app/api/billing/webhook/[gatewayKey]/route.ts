import { NextRequest, NextResponse } from "next/server";
import { handlePaymentWebhook } from "@/lib/billing/paymentOrders";
import { MockPaymentGatewayProvider } from "@/lib/providers/payment_gateway/adapters/mock";
import { RazorpayPaymentGatewayProvider } from "@/lib/providers/payment_gateway/adapters/razorpay";
import { WebhookSignatureError } from "@/lib/providers/payment_gateway/types";

/**
 * POST /api/billing/webhook/[gatewayKey] — inbound payment-gateway webhook.
 * Like Phase 2's telephony webhooks, this has NO session/tenant context;
 * verification + org attribution happens entirely inside
 * `handlePaymentWebhook()` / `credit_wallet_from_payment()`
 * (db/migrations/012_phase7_billing.sql).
 *
 * Phase 7 scope note: this reads the PLATFORM's own gateway credentials
 * from environment variables (one gateway account per deployment), rather
 * than a per-tenant `tenant_provider_config` row — a tenant never brings
 * its own Razorpay account in Phase 7's single-tenant-billing scope (see
 * docs/STACK_PROPOSAL.md's Phase 8 extension note).
 */

function resolveGateway(gatewayKey: string) {
  if (gatewayKey === "mock") {
    return new MockPaymentGatewayProvider();
  }
  if (gatewayKey === "razorpay") {
    return new RazorpayPaymentGatewayProvider({
      key_id: process.env.RAZORPAY_KEY_ID ?? "",
      key_secret: process.env.RAZORPAY_KEY_SECRET ?? "",
      webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
    });
  }
  return null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ gatewayKey: string }> }): Promise<NextResponse> {
  const { gatewayKey } = await ctx.params;
  const gateway = resolveGateway(gatewayKey);
  if (!gateway) {
    return NextResponse.json({ error: `Unknown payment gateway "${gatewayKey}"` }, { status: 404 });
  }

  const rawBody = await req.text();
  const headers: Record<string, string | string[] | undefined> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  try {
    const result = await handlePaymentWebhook({
      gatewayProviderKey: gatewayKey,
      headers,
      rawBody,
      verify: (h, b) => gateway.verifyAndParseWebhook(h, b),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : "Failed to process webhook";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
