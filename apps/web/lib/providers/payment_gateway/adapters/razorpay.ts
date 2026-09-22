import { createHmac, timingSafeEqual } from "crypto";
import { registerAdapter } from "../../adapter-map";
import type {
  CreatePaymentLinkParams,
  CreatePaymentLinkResult,
  NormalizedPaymentWebhookEvent,
  PaymentGatewayProvider,
  ProviderConfig,
} from "../types";
import { WebhookSignatureError } from "../types";

/**
 * RazorpayPaymentGatewayProvider — real REST API adapter.
 *
 * Picked as the Phase 7 primary per docs/VERIFICATION.md (2026-09-22) /
 * docs/STACK_PROPOSAL.md: developer-friendly APIs, mature Payment
 * Links + webhook-signature-verification products, the common choice for
 * an India SaaS with recurring/wallet billing. Re-verify current TDR/
 * pricing before go-live, same caveat as every other adapter in this repo.
 *
 * Verified against Razorpay's published docs:
 *  - Create a Payment Link: POST https://api.razorpay.com/v1/payment_links
 *    JSON body: { amount (paise), currency, description, callback_url, ... }
 *    Basic Auth (key_id:key_secret). Response: { id, short_url, ... }.
 *    https://razorpay.com/docs/api/payments/payment-links/create/
 *  - Webhook signature: `X-Razorpay-Signature` header = HMAC-SHA256(raw
 *    request body, key = webhook secret), hex-encoded, constant-time
 *    compared. https://razorpay.com/docs/webhooks/validate-test/
 *  - Webhook payload shape (payment_link.paid event):
 *    { event: "payment_link.paid", payload: { payment_link: { entity: { id, amount, currency } },
 *      payment: { entity: { id, status } } } }
 *
 * NEEDS A REAL RAZORPAY ACCOUNT to smoke-test end-to-end. That is an
 * infra/business step, not a code gap — this adapter is unit-tested
 * against a mocked HTTP client + a hand-computed HMAC signature (see
 * apps/web/tests/billing/razorpay-adapter.test.ts), no live keys needed.
 */

export type RazorpayConfig = ProviderConfig & {
  key_id: string;
  key_secret: string;
  webhook_secret?: string;
  /** Override for testing; defaults to Razorpay's production API host. */
  base_url?: string;
};

const DEFAULT_BASE_URL = "https://api.razorpay.com/v1";

export class RazorpayPaymentGatewayProvider implements PaymentGatewayProvider {
  readonly providerKey = "razorpay";

  private readonly config: RazorpayConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ProviderConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config as RazorpayConfig;
    if (!this.config.key_id || !this.config.key_secret) {
      throw new Error("RazorpayPaymentGatewayProvider requires key_id and key_secret");
    }
    this.fetchImpl = fetchImpl;
  }

  private authHeader(): string {
    const token = Buffer.from(`${this.config.key_id}:${this.config.key_secret}`).toString("base64");
    return `Basic ${token}`;
  }

  private baseUrl(): string {
    return this.config.base_url ?? DEFAULT_BASE_URL;
  }

  async createPaymentLink(params: CreatePaymentLinkParams): Promise<CreatePaymentLinkResult> {
    // Razorpay amounts are in the smallest currency unit (paise for INR).
    const amountInSubunits = Math.round(params.amount * 100);
    const res = await this.fetchImpl(`${this.baseUrl()}/payment_links`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amountInSubunits,
        currency: params.currency,
        description: params.description,
        callback_url: params.callbackUrl,
        notes: { org_id: params.orgId },
      }),
    });
    if (!res.ok) {
      throw new Error(`Razorpay createPaymentLink failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { id: string; short_url: string };
    return { providerOrderId: body.id, paymentUrl: body.short_url };
  }

  async verifyAndParseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string
  ): Promise<NormalizedPaymentWebhookEvent> {
    const secret = this.config.webhook_secret;
    if (!secret) {
      throw new Error("RazorpayPaymentGatewayProvider: webhook_secret not configured");
    }
    const signatureHeader = headers["x-razorpay-signature"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!signature) {
      throw new WebhookSignatureError("missing X-Razorpay-Signature header");
    }
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookSignatureError("HMAC signature mismatch");
    }

    const payload = JSON.parse(rawBody) as {
      event: string;
      payload: {
        payment_link?: { entity: { id: string; amount: number; currency: string } };
        payment?: { entity: { id: string; status: string } };
      };
    };

    const linkEntity = payload.payload?.payment_link?.entity;
    const paymentEntity = payload.payload?.payment?.entity;
    const isPaymentCaptured =
      payload.event === "payment_link.paid" || paymentEntity?.status === "captured";

    return {
      // Razorpay does not send a distinct webhook-delivery id in the body
      // by default; the signature itself is over the exact payload, so a
      // hash of (event + linked order id + payment id) is a stable,
      // provider-independent idempotency key for a retried identical
      // delivery.
      idempotencyKey: `${payload.event}:${linkEntity?.id ?? ""}:${paymentEntity?.id ?? ""}`,
      providerOrderId: linkEntity?.id ?? "",
      eventType: payload.event,
      isPaymentCaptured,
      amount: linkEntity ? linkEntity.amount / 100 : 0,
      currency: linkEntity?.currency ?? "INR",
      raw: payload,
    };
  }
}

registerAdapter("payment_gateway.razorpay", (config) => new RazorpayPaymentGatewayProvider(config));
