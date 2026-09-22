import { describe, it, expect, beforeEach } from "vitest";
import { MockWhatsAppProvider } from "@/lib/providers/whatsapp/adapters/mock";

describe("MockWhatsAppProvider", () => {
  beforeEach(() => {
    MockWhatsAppProvider._resetForTests();
  });

  it("implements every generalized (non-real-estate-hardcoded) send verb", async () => {
    const provider = new MockWhatsAppProvider();
    const base = { toNumber: "+919876543210", orgId: "org-1", templateKey: "generic_template" };

    await provider.sendDocument({ ...base, documentUrl: "https://example.com/doc.pdf" });
    await provider.sendMedia({ ...base, mediaUrl: "https://example.com/img.jpg", mediaType: "image" });
    await provider.sendLocation({ ...base, latitude: 25.6, longitude: 85.1 });
    await provider.sendAppointmentConfirmation({
      ...base,
      appointmentId: "appt-1",
      scheduledAtIso: new Date().toISOString(),
    });
    await provider.sendReminder({ ...base, appointmentId: "appt-1" });
    await provider.sendFollowUp({ ...base, leadId: "lead-1" });

    const sent = MockWhatsAppProvider._sentForTests();
    expect(sent.map((s) => s.method)).toEqual([
      "sendDocument",
      "sendMedia",
      "sendLocation",
      "sendAppointmentConfirmation",
      "sendReminder",
      "sendFollowUp",
    ]);
    expect(sent.every((s) => s.toNumber === "+919876543210")).toBe(true);
  });

  it("returns a stable, unique providerMessageId per send", async () => {
    const provider = new MockWhatsAppProvider();
    const r1 = await provider.sendReminder({ toNumber: "+91", orgId: "o", templateKey: "t" });
    const r2 = await provider.sendReminder({ toNumber: "+91", orgId: "o", templateKey: "t" });
    expect(r1.providerMessageId).not.toBe(r2.providerMessageId);
    expect(r1.status).toBe("sent");
  });
});
