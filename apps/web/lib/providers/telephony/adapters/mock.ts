import { randomUUID, createHash } from "crypto";
import { registerAdapter } from "../../adapter-map";
import type {
  CallStatus,
  CallStatusResult,
  CreateCallParams,
  CreateCallResult,
  NormalizedWebhookEvent,
  ProviderConfig,
  RecordCallResult,
  StreamAudioParams,
  TelephonyProvider,
} from "../types";

/**
 * MockTelephonyProvider — fully in-memory, deterministic fake call
 * lifecycle (queued -> ringing -> in_progress -> completed). No network
 * calls. Used for demo mode and the whole test suite so the rest of the app
 * can be built/exercised without live telephony credentials.
 *
 * Not a singleton across requests in a real deployment (each Next.js
 * instance/process gets its own in-memory Map), which is fine: it exists to
 * make `createCall` -> `getCallStatus` -> webhook-shaped events observable
 * within a single test/demo session, not to be a real telephony backend.
 */

type MockCallState = {
  status: CallStatus;
  toNumber: string;
  fromNumber: string;
  orgId: string;
  appCallId: string;
  createdAt: number;
};

const calls = new Map<string, MockCallState>();

export class MockTelephonyProvider implements TelephonyProvider {
  readonly providerKey = "mock";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: ProviderConfig = {}) {}

  async createCall(params: CreateCallParams): Promise<CreateCallResult> {
    const providerCallId = `mock_${randomUUID()}`;
    calls.set(providerCallId, {
      status: "ringing",
      toNumber: params.toNumber,
      fromNumber: params.fromNumber,
      orgId: params.orgId,
      appCallId: params.appCallId,
      createdAt: Date.now(),
    });
    return { providerCallId, status: "ringing" };
  }

  async endCall(providerCallId: string): Promise<void> {
    const call = this.mustGet(providerCallId);
    call.status = "completed";
  }

  async transferCall(providerCallId: string, toNumber: string): Promise<void> {
    const call = this.mustGet(providerCallId);
    call.toNumber = toNumber;
  }

  async getCallStatus(providerCallId: string): Promise<CallStatusResult> {
    const call = this.mustGet(providerCallId);
    // Deterministic lifecycle: the call is "ringing" only until the first
    // status check after createCall, then "answered" (in_progress) — no
    // real timers/sleeps needed to observe the full
    // ringing -> answered -> ended contract in a test.
    if (call.status === "ringing") {
      call.status = "in_progress";
    }
    const ageMs = Date.now() - call.createdAt;
    return {
      providerCallId,
      status: call.status,
      durationSeconds: call.status === "completed" ? Math.max(1, Math.round(ageMs / 1000)) : undefined,
    };
  }

  async streamAudio(params: StreamAudioParams): Promise<void> {
    // No-op: mock mode has no real media, nothing to open a socket to.
    void params;
  }

  async receiveWebhook(
    _headers: Record<string, string | string[] | undefined>,
    rawBody: string
  ): Promise<NormalizedWebhookEvent> {
    // Mock "signature verification" always passes — there is no real
    // provider on the other end. The idempotency key is derived from the
    // body hash so re-posting the exact same payload in a test is a no-op,
    // matching how a real provider's retried delivery would be deduped.
    const payload = JSON.parse(rawBody) as {
      provider_call_id: string;
      event_type: string;
      status?: CallStatus;
      idempotency_key?: string;
    };
    const idempotencyKey =
      payload.idempotency_key ?? createHash("sha256").update(rawBody).digest("hex");
    if (payload.status) {
      const call = calls.get(payload.provider_call_id);
      if (call) call.status = payload.status;
    }
    return {
      idempotencyKey,
      providerCallId: payload.provider_call_id,
      eventType: payload.event_type,
      status: payload.status,
      raw: payload,
    };
  }

  async recordCall(providerCallId: string): Promise<RecordCallResult> {
    this.mustGet(providerCallId);
    return { recordingUrl: `https://mock.local/recordings/${providerCallId}.wav` };
  }

  private mustGet(providerCallId: string): MockCallState {
    const call = calls.get(providerCallId);
    if (!call) throw new Error(`MockTelephonyProvider: unknown providerCallId ${providerCallId}`);
    return call;
  }

  /** Test-only: reset in-memory state between test files/runs. */
  static _resetForTests(): void {
    calls.clear();
  }
}

registerAdapter("telephony.mock", (config) => new MockTelephonyProvider(config));
