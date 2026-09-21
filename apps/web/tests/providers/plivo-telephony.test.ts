import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { PlivoTelephonyProvider } from "@/lib/providers/telephony/adapters/plivo";
import { WebhookSignatureError } from "@/lib/providers/telephony/types";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const config = {
  auth_id: "MAXXXXXXXXXXXXXXXXXX",
  auth_token: "test_auth_token_12345",
  answer_url: "https://app.example.com/voice/answer",
};

describe("PlivoTelephonyProvider", () => {
  it("createCall POSTs to /Account/{auth_id}/Call/ with Basic auth and returns the request_uuid", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ request_uuid: "req-123", message: "call queued" }));
    const provider = new PlivoTelephonyProvider(config, fetchMock as unknown as typeof fetch);

    const result = await provider.createCall({
      toNumber: "+911234567890",
      fromNumber: "+919876543210",
      orgId: "org-1",
      appCallId: "app-1",
    });

    expect(result).toEqual({ providerCallId: "req-123", status: "queued" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.plivo.com/v1/Account/${config.auth_id}/Call/`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(
      "Basic " + Buffer.from(`${config.auth_id}:${config.auth_token}`).toString("base64")
    );
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ from: "+919876543210", to: "+911234567890", answer_url: config.answer_url });
  });

  it("createCall throws with a descriptive error on a non-OK response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, false, 400));
    const provider = new PlivoTelephonyProvider(config, fetchMock as unknown as typeof fetch);
    await expect(
      provider.createCall({ toNumber: "+91", fromNumber: "+91", orgId: "o", appCallId: "a" })
    ).rejects.toThrow(/Plivo createCall failed: 400/);
  });

  it("getCallStatus maps Plivo's call_status vocabulary to our CallStatus", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ call_status: "in-progress", call_duration: "42" }));
    const provider = new PlivoTelephonyProvider(config, fetchMock as unknown as typeof fetch);
    const result = await provider.getCallStatus("req-123");
    expect(result).toEqual({ providerCallId: "req-123", status: "in_progress", durationSeconds: 42 });
  });

  it("endCall issues a DELETE to the call resource", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    const provider = new PlivoTelephonyProvider(config, fetchMock as unknown as typeof fetch);
    await provider.endCall("req-123");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.plivo.com/v1/Account/${config.auth_id}/Call/req-123/`);
    expect(init.method).toBe("DELETE");
  });

  function signPlivoV3(rawBody: string, requestUrl: string, nonce: string, authToken: string): string {
    const params = new URLSearchParams(rawBody);
    const sortedValues = Array.from(params.keys())
      .sort()
      .map((k) => params.get(k) ?? "")
      .join("");
    const message = `${requestUrl}${sortedValues}${nonce}`;
    return createHmac("sha256", authToken).update(message).digest("base64");
  }

  it("receiveWebhook accepts a correctly-signed X-Plivo-Signature-V3 webhook and normalizes it", async () => {
    const provider = new PlivoTelephonyProvider(config);
    const rawBody = "CallUUID=call-uuid-1&Event=StartApp&CallStatus=in-progress";
    const requestUrl = "https://app.example.com/api/calls/webhook/plivo";
    const nonce = "nonce-abc";
    const signature = signPlivoV3(rawBody, requestUrl, nonce, config.auth_token);

    const event = await provider.receiveWebhook(
      {
        "x-plivo-signature-v3": signature,
        "x-plivo-signature-v3-nonce": nonce,
        "x-plivo-request-url": requestUrl,
      },
      rawBody
    );

    expect(event.providerCallId).toBe("call-uuid-1");
    expect(event.status).toBe("in_progress");
    expect(event.idempotencyKey).toHaveLength(64); // sha256 hex
  });

  it("receiveWebhook rejects a tampered/incorrect signature", async () => {
    const provider = new PlivoTelephonyProvider(config);
    const rawBody = "CallUUID=call-uuid-1&Event=StartApp&CallStatus=in-progress";
    await expect(
      provider.receiveWebhook(
        {
          "x-plivo-signature-v3": "not-the-right-signature",
          "x-plivo-signature-v3-nonce": "nonce-abc",
          "x-plivo-request-url": "https://app.example.com/api/calls/webhook/plivo",
        },
        rawBody
      )
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("receiveWebhook rejects when required signature headers are missing", async () => {
    const provider = new PlivoTelephonyProvider(config);
    await expect(provider.receiveWebhook({}, "CallUUID=x")).rejects.toThrow(WebhookSignatureError);
  });
});
