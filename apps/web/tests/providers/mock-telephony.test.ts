import { describe, it, expect, beforeEach } from "vitest";
import { MockTelephonyProvider } from "@/lib/providers/telephony/adapters/mock";

describe("MockTelephonyProvider", () => {
  beforeEach(() => {
    MockTelephonyProvider._resetForTests();
  });

  it("runs a deterministic ringing -> in_progress -> completed lifecycle", async () => {
    const provider = new MockTelephonyProvider();
    const { providerCallId, status } = await provider.createCall({
      toNumber: "+911234567890",
      fromNumber: "+919876543210",
      orgId: "org-1",
      appCallId: "app-call-1",
    });
    expect(status).toBe("ringing");

    const afterRing = await provider.getCallStatus(providerCallId);
    expect(afterRing.status).toBe("in_progress");

    await provider.endCall(providerCallId);
    const afterEnd = await provider.getCallStatus(providerCallId);
    expect(afterEnd.status).toBe("completed");
    expect(afterEnd.durationSeconds).toBeGreaterThanOrEqual(1);
  });

  it("supports transferCall and recordCall", async () => {
    const provider = new MockTelephonyProvider();
    const { providerCallId } = await provider.createCall({
      toNumber: "+911234567890",
      fromNumber: "+919876543210",
      orgId: "org-1",
      appCallId: "app-call-2",
    });
    await expect(provider.transferCall(providerCallId, "+911111111111")).resolves.toBeUndefined();
    const recording = await provider.recordCall(providerCallId);
    expect(recording.recordingUrl).toContain(providerCallId);
  });

  it("receiveWebhook normalizes a payload and derives an idempotency key from the body", async () => {
    const provider = new MockTelephonyProvider();
    const { providerCallId } = await provider.createCall({
      toNumber: "+911234567890",
      fromNumber: "+919876543210",
      orgId: "org-1",
      appCallId: "app-call-3",
    });

    const body = JSON.stringify({ provider_call_id: providerCallId, event_type: "status", status: "completed" });
    const event1 = await provider.receiveWebhook({}, body);
    const event2 = await provider.receiveWebhook({}, body);

    expect(event1.idempotencyKey).toBe(event2.idempotencyKey);
    expect(event1.status).toBe("completed");
  });

  it("throws for an unknown providerCallId", async () => {
    const provider = new MockTelephonyProvider();
    await expect(provider.getCallStatus("nonexistent")).rejects.toThrow();
  });
});
