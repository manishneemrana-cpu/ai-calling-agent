import { randomUUID, createHash } from "crypto";
import { registerAdapter } from "../../adapter-map";
import type {
  CreatePaymentLinkParams,
  CreatePaymentLinkResult,
  NormalizedPaymentWebhookEvent,
  PaymentGatewayProvider,
  ProviderConfig,
} from "../types";

/**
 * MockPaymentGatewayProvider — deterministic, in-memory fake. No network
 * calls, "signature verification" always passes (there is no real gateway
 * on the other end). Used for demo mode and the whole test suite, same
 * role as MockTelephonyProvider (Phase 2) / MockWhatsAppProvider (Phase 6).
 */

type MockOrder = { amount: number; currency: string };
const orders = new Map<string, MockOrder>();

export class MockPaymentGatewayProvider implements PaymentGatewayProvider {
  readonly providerKey = "mock";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: ProviderConfig = {}) {}

  async createPaymentLink(params: CreatePaymentLinkParams): Promise<CreatePaymentLinkResult> {
    const providerOrderId = `mock_order_${randomUUID()}`;
    orders.set(providerOrderId, { amount: params.amount, currency: params.currency });
    return { providerOrderId, paymentUrl: `https://mock-gateway.local/pay/${providerOrderId}` };
  }

  async verifyAndParseWebhook(
    _headers: Record<string, string | string[] | undefined>,
    rawBody: string
  ): Promise<NormalizedPaymentWebhookEvent> {
    const payload = JSON.parse(rawBody) as {
      provider_order_id: string;
      event_type?: string;
      status?: "captured" | "failed";
      idempotency_key?: string;
    };
    const order = orders.get(payload.provider_order_id);
    const idempotencyKey =
      payload.idempotency_key ?? createHash("sha256").update(rawBody).digest("hex");
    return {
      idempotencyKey,
      providerOrderId: payload.provider_order_id,
      eventType: payload.event_type ?? "payment.status",
      isPaymentCaptured: payload.status === "captured",
      amount: order?.amount ?? 0,
      currency: order?.currency ?? "INR",
      raw: payload,
    };
  }

  /** Test-only: reset in-memory state between test files/runs. */
  static _resetForTests(): void {
    orders.clear();
  }
}

registerAdapter("payment_gateway.mock", (config) => new MockPaymentGatewayProvider(config));
