import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { FreJunTelerTelephonyProvider } from "@/lib/providers/telephony/adapters/frejun-teler";
import { WebhookSignatureError } from "@/lib/providers/telephony/types";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const config = {
  api_key: "test_api_key",
  account_id: "acct_123",
  flow_url: "https://app.example.com/voice/flow",
  status_callback_url: "https://app.example.com/voice/status",
  webhook_secret: "whsec_test_secret",
};

describe("FreJunTelerTelephonyProvider", () => {
  it("createCall POSTs to /accounts/{account_id}/calls with Bearer auth and returns call_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ call_id: "fj-call-1", status: "queued" }));
    const provider = new FreJunTelerTelephonyProvider(config, fetchMock as unknown as typeof fetch);

    const result = await provider.createCall({
      toNumber: "+911234567890",
      fromNumber: "+919876543210",
      orgId: "org-1",
      appCallId: "app-1",
    });

    expect(result).toEqual({ providerCallId: "fj-call-1", status: "queued" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.teler.ai/v1/accounts/${config.account_id}/calls`);
    expect(init.headers.Authorization).toBe(`Bearer ${config.api_key}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      from_number: "+919876543210",
      to_number: "+911234567890",
      flow_url: config.flow_url,
      status_callback_url: config.status_callback_url,
      client_reference: "app-1",
    });
  });

  it("createCall throws with a descriptive error on a non-OK response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "bad request" }, false, 422));
    const provider = new FreJunTelerTelephonyProvider(config, fetchMock as unknown as typeof fetch);
    await expect(
      provider.createCall({ toNumber: "+91", fromNumber: "+91", orgId: "o", appCallId: "a" })
    ).rejects.toThrow(/FreJun Teler createCall failed: 422/);
  });

  it("getCallStatus maps FreJun's status vocabulary to our CallStatus", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "answered", duration_seconds: 30 }));
    const provider = new FreJunTelerTelephonyProvider(config, fetchMock as unknown as typeof fetch);
    const result = await provider.getCallStatus("fj-call-1");
    expect(result).toEqual({ providerCallId: "fj-call-1", status: "in_progress", durationSeconds: 30 });
  });

  it("endCall POSTs to /calls/{id}/hangup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const provider = new FreJunTelerTelephonyProvider(config, fetchMock as unknown as typeof fetch);
    await provider.endCall("fj-call-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.teler.ai/v1/calls/fj-call-1/hangup");
    expect(init.method).toBe("POST");
  });

  it("receiveWebhook accepts a correctly HMAC-signed payload and normalizes it", async () => {
    const provider = new FreJunTelerTelephonyProvider(config);
    const payload = { event_id: "evt-1", call_id: "fj-call-1", event: "call.completed", status: "completed" };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", config.webhook_secret).update(rawBody).digest("hex");

    const event = await provider.receiveWebhook({ "x-teler-signature": signature }, rawBody);

    expect(event.providerCallId).toBe("fj-call-1");
    expect(event.status).toBe("completed");
    expect(event.idempotencyKey).toBe("evt-1");
  });

  it("receiveWebhook rejects an incorrect signature", async () => {
    const provider = new FreJunTelerTelephonyProvider(config);
    const rawBody = JSON.stringify({ call_id: "fj-call-1", event: "call.completed" });
    await expect(
      provider.receiveWebhook({ "x-teler-signature": "wrong" }, rawBody)
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("receiveWebhook fails closed when no webhook_secret is configured", async () => {
    const providerNoSecret = new FreJunTelerTelephonyProvider({
      api_key: "x",
      account_id: "y",
      flow_url: "z",
      status_callback_url: "z",
    });
    await expect(
      providerNoSecret.receiveWebhook({ "x-teler-signature": "anything" }, "{}")
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("a retried webhook delivery (identical event_id) produces the same idempotency key", async () => {
    const provider = new FreJunTelerTelephonyProvider(config);
    const payload = { event_id: "evt-retry-1", call_id: "fj-call-1", event: "call.completed", status: "completed" };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", config.webhook_secret).update(rawBody).digest("hex");
    const headers = { "x-teler-signature": signature };

    const first = await provider.receiveWebhook(headers, rawBody);
    const second = await provider.receiveWebhook(headers, rawBody);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });
});
