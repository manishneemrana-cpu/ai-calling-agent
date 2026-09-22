import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { RazorpayPaymentGatewayProvider } from "@/lib/providers/payment_gateway/adapters/razorpay";
import { WebhookSignatureError } from "@/lib/providers/payment_gateway/types";

/**
 * Unit-tests the Razorpay adapter against a mocked HTTP client + a
 * hand-computed HMAC signature — no live Razorpay keys needed, same
 * testable-without-live-keys pattern as
 * apps/web/tests/providers/plivo-telephony.test.ts.
 */

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("RazorpayPaymentGatewayProvider.createPaymentLink", () => {
  it("converts rupees to paise and posts to /payment_links, Basic-authed", async () => {
    const fetchImpl = fakeFetch(200, { id: "plink_abc123", short_url: "https://rzp.io/i/abc123" });
    const provider = new RazorpayPaymentGatewayProvider(
      { key_id: "rzp_test_key", key_secret: "rzp_test_secret" },
      fetchImpl
    );

    const result = await provider.createPaymentLink({
      orgId: "org-1",
      amount: 500,
      currency: "INR",
      description: "Wallet top-up",
    });

    expect(result).toEqual({ providerOrderId: "plink_abc123", paymentUrl: "https://rzp.io/i/abc123" });

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.razorpay.com/v1/payment_links");
    const body = JSON.parse(init.body as string);
    expect(body.amount).toBe(50000); // 500 rupees -> 50,000 paise
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("rzp_test_key:rzp_test_secret").toString("base64")}`
    );
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = fakeFetch(401, { error: { description: "Authentication failed" } });
    const provider = new RazorpayPaymentGatewayProvider({ key_id: "k", key_secret: "s" }, fetchImpl);
    await expect(
      provider.createPaymentLink({ orgId: "org-1", amount: 100, currency: "INR", description: "x" })
    ).rejects.toThrow(/Razorpay createPaymentLink failed/);
  });
});

describe("RazorpayPaymentGatewayProvider.verifyAndParseWebhook", () => {
  const secret = "whsec_test_secret";
  const provider = new RazorpayPaymentGatewayProvider({ key_id: "k", key_secret: "s", webhook_secret: secret });

  function signedPayload() {
    const payload = {
      event: "payment_link.paid",
      payload: {
        payment_link: { entity: { id: "plink_xyz", amount: 50000, currency: "INR" } },
        payment: { entity: { id: "pay_123", status: "captured" } },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    return { rawBody, signature };
  }

  it("verifies a correctly-signed payload and normalizes it", async () => {
    const { rawBody, signature } = signedPayload();
    const event = await provider.verifyAndParseWebhook({ "x-razorpay-signature": signature }, rawBody);
    expect(event.isPaymentCaptured).toBe(true);
    expect(event.providerOrderId).toBe("plink_xyz");
    expect(event.amount).toBeCloseTo(500); // 50000 paise -> 500 rupees
  });

  it("rejects a payload with a tampered/missing signature", async () => {
    const { rawBody } = signedPayload();
    await expect(
      provider.verifyAndParseWebhook({ "x-razorpay-signature": "0".repeat(64) }, rawBody)
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(provider.verifyAndParseWebhook({}, rawBody)).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("produces the SAME idempotencyKey for the same event delivered twice", async () => {
    const { rawBody, signature } = signedPayload();
    const first = await provider.verifyAndParseWebhook({ "x-razorpay-signature": signature }, rawBody);
    const second = await provider.verifyAndParseWebhook({ "x-razorpay-signature": signature }, rawBody);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });
});
