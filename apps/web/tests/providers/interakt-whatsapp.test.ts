import { describe, it, expect, vi } from "vitest";
import { InteraktWhatsAppProvider } from "@/lib/providers/whatsapp/adapters/interakt";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const config = { api_key: "test_api_key", waba_id: "waba_123" };

describe("InteraktWhatsAppProvider", () => {
  it("sendReminder POSTs a template message with Basic auth and returns the provider message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "msg-123" }));
    const provider = new InteraktWhatsAppProvider(config, fetchMock as unknown as typeof fetch);

    const result = await provider.sendReminder({
      toNumber: "+919876543210",
      orgId: "org-1",
      templateKey: "appointment_reminder",
      variables: { "1": "Ramesh", "2": "3 PM" },
    });

    expect(result).toEqual({ providerMessageId: "msg-123", status: "sent" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.interakt.ai/v1/public/message/");
    expect(init.headers.Authorization).toBe("Basic test_api_key");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      countryCode: "+91",
      phoneNumber: "9876543210",
      type: "Template",
      template: { name: "appointment_reminder", languageCode: "en", bodyValues: ["Ramesh", "3 PM"] },
    });
  });

  it("throws a descriptive error on a non-OK response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "bad template" }, false, 400));
    const provider = new InteraktWhatsAppProvider(config, fetchMock as unknown as typeof fetch);
    await expect(
      provider.sendFollowUp({ toNumber: "+9198", orgId: "o", templateKey: "t", leadId: "lead-1" })
    ).rejects.toThrow(/Interakt send failed: 400/);
  });

  it("requires api_key and waba_id at construction", () => {
    expect(() => new InteraktWhatsAppProvider({})).toThrow(/api_key and config.waba_id/);
  });

  it("splits an already-E.164 +91 number into countryCode/phoneNumber", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "m1" }));
    const provider = new InteraktWhatsAppProvider(config, fetchMock as unknown as typeof fetch);
    await provider.sendAppointmentConfirmation({
      toNumber: "+919876543210",
      orgId: "o",
      templateKey: "appt_confirm",
      appointmentId: "a1",
      scheduledAtIso: "2026-10-01T10:00:00Z",
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.countryCode).toBe("+91");
    expect(body.phoneNumber).toBe("9876543210");
  });
});
