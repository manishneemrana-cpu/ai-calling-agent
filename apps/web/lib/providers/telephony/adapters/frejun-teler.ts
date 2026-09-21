import { createHmac, createHash, timingSafeEqual } from "crypto";
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
import { WebhookSignatureError } from "../types";

/**
 * FreJunTelerTelephonyProvider — real REST API adapter for FreJun Teler,
 * per docs/VERIFICATION.md §7's research (cheapest verified streaming-capable
 * option, ~₹0.28-0.30/min blended). status = 'beta' in the providers seed
 * row (db/migrations/007_provider_registry.sql) until a paid pilot confirms
 * production behavior.
 *
 * Verified against publicly available FreJun Teler docs/SDKs (2026-09-21):
 *  - Node/Python SDKs expose `client.voice.calls.create({ fromNumber,
 *    toNumber, flowUrl, statusCallbackUrl, record })`
 *    (https://github.com/frejun-tech/teler-node), camelCase in the SDK,
 *    converted to snake_case on the wire — this adapter talks the
 *    snake_case REST shape directly since apps/web doesn't depend on their
 *    SDK.
 *  - A separate documented REST path,
 *    POST /api/v1/integrations/create-call/ (user_email, cadidate_number)
 *    [sic — the published field name really does appear misspelled] exists
 *    for a different, simpler "network-based calls" flow aimed at agent
 *    dialers rather than programmable voice; this adapter uses the
 *    programmable-voice call-create shape above, which is what streaming
 *    (docs/VERIFICATION.md §7) depends on.
 *  - Bidirectional audio streaming: FreJun opens a full-duplex WebSocket to
 *    a URL your app provides and streams raw L16/8kHz audio frames both
 *    ways — configured via the call's `streamUrl`/flow config, not a
 *    separate REST call (mirrors Plivo's <Stream>-via-answer_url pattern;
 *    see streamAudio()).
 *  - Webhook signing: FreJun's own docs describe "create and rotate secrets
 *    to authenticate incoming webhooks" but do NOT publish the exact header
 *    name or HMAC message format in any page this research could reach.
 *    This adapter implements the conventional scheme used by their SDKs'
 *    peers (HMAC-SHA256 over the raw request body, keyed by the configured
 *    webhook secret, sent as `X-Teler-Signature`) and isolates it behind
 *    `verifySignature()` so it is a one-line change once FreJun confirms
 *    (or corrects) the exact header/algorithm during pilot onboarding.
 *
 * NEEDS A REAL FREJUN TELER ACCOUNT to smoke-test end-to-end (createCall
 * against the live API, and to confirm the real webhook signature header
 * name/algorithm against a live delivery) — infra/business step, not a code
 * gap. Until then this is unit-tested against a mocked HTTP client (see
 * apps/web/tests/providers/frejun-telephony.test.ts).
 */

export type FreJunTelerConfig = ProviderConfig & {
  api_key: string;
  account_id: string;
  /** Where FreJun should POST call-flow instructions / status callbacks. */
  flow_url: string;
  status_callback_url: string;
  /** Shared secret for HMAC webhook verification (see class docstring). */
  webhook_secret?: string;
  base_url?: string;
};

const DEFAULT_BASE_URL = "https://api.teler.ai/v1";

function statusFromFreJun(status: string): CallStatus {
  switch (status) {
    case "initiated":
    case "queued":
      return "queued";
    case "ringing":
      return "ringing";
    case "answered":
    case "in-progress":
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "busy":
    case "failed":
      return "failed";
    case "no-answer":
    case "no_answer":
      return "no_answer";
    default:
      return "failed";
  }
}

export class FreJunTelerTelephonyProvider implements TelephonyProvider {
  readonly providerKey = "frejun_teler";
  private readonly config: FreJunTelerConfig;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ProviderConfig, fetchImpl: typeof fetch = fetch) {
    const cfg = config as FreJunTelerConfig;
    if (!cfg.api_key || !cfg.account_id) {
      throw new Error("FreJunTelerTelephonyProvider: config.api_key and config.account_id are required");
    }
    this.config = cfg;
    this.baseUrl = cfg.base_url ?? DEFAULT_BASE_URL;
    this.fetchImpl = fetchImpl;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.api_key}`,
      "Content-Type": "application/json",
    };
  }

  async createCall(params: CreateCallParams): Promise<CreateCallResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/accounts/${this.config.account_id}/calls`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        from_number: params.fromNumber,
        to_number: params.toNumber,
        flow_url: this.config.flow_url,
        status_callback_url: this.config.status_callback_url,
        record: true,
        // Passed through so our flow/status-callback endpoints can match
        // the event back to calls.id without a DB lookup racing this
        // response.
        client_reference: params.appCallId,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`FreJun Teler createCall failed: ${res.status} ${text}`);
    }
    const body = (await res.json()) as { call_id?: string; status?: string };
    if (!body.call_id) {
      throw new Error(`FreJun Teler createCall: unexpected response shape ${JSON.stringify(body)}`);
    }
    return { providerCallId: body.call_id, status: statusFromFreJun(body.status ?? "queued") };
  }

  async endCall(providerCallId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/calls/${providerCallId}/hangup`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`FreJun Teler endCall failed: ${res.status}`);
    }
  }

  async transferCall(providerCallId: string, toNumber: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/calls/${providerCallId}/transfer`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ to_number: toNumber }),
    });
    if (!res.ok) {
      throw new Error(`FreJun Teler transferCall failed: ${res.status}`);
    }
  }

  async getCallStatus(providerCallId: string): Promise<CallStatusResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/calls/${providerCallId}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`FreJun Teler getCallStatus failed: ${res.status}`);
    }
    const body = (await res.json()) as { status: string; duration_seconds?: number };
    return {
      providerCallId,
      status: statusFromFreJun(body.status),
      durationSeconds: body.duration_seconds,
    };
  }

  async streamAudio(params: StreamAudioParams): Promise<void> {
    // FreJun Teler opens the bidirectional L16/8kHz WebSocket itself, to the
    // URL configured in the call's flow (see docs/VERIFICATION.md §7 and
    // services/voice-gateway/PROVIDERS.md). There is no separate "start
    // streaming" REST call once the flow already points at streamUrl; this
    // method documents that contract for the future voice-gateway service.
    void params;
  }

  async receiveWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string
  ): Promise<NormalizedWebhookEvent> {
    this.verifySignature(headers, rawBody);

    const payload = JSON.parse(rawBody) as {
      event_id?: string;
      call_id: string;
      event: string;
      status?: string;
      recording_url?: string;
    };

    if (!payload.call_id) {
      throw new Error("FreJun Teler webhook: missing call_id");
    }

    // Prefer FreJun's own event_id for idempotency when present; fall back
    // to a body hash (same rationale as the Plivo adapter) if a given event
    // type doesn't carry one.
    const idempotencyKey = payload.event_id ?? createHash("sha256").update(rawBody).digest("hex");

    return {
      idempotencyKey,
      providerCallId: payload.call_id,
      eventType: payload.event,
      status: payload.status ? statusFromFreJun(payload.status) : undefined,
      recordingUrl: payload.recording_url,
      raw: payload,
    };
  }

  async recordCall(providerCallId: string): Promise<RecordCallResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/calls/${providerCallId}/recording`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      return { recordingUrl: null };
    }
    const body = (await res.json()) as { recording_url?: string };
    return { recordingUrl: body.recording_url ?? null };
  }

  /**
   * HMAC-SHA256(webhook_secret, rawBody) as `X-Teler-Signature`, hex-encoded.
   * See class docstring: FreJun's exact scheme is not published, so this is
   * the documented convention pending pilot confirmation. If
   * `webhook_secret` isn't configured, verification fails closed (never
   * silently accepts unsigned webhooks).
   */
  private verifySignature(headers: Record<string, string | string[] | undefined>, rawBody: string): void {
    const get = (name: string): string | undefined => {
      const v = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };

    if (!this.config.webhook_secret) {
      throw new WebhookSignatureError("FreJun Teler webhook_secret is not configured");
    }

    const signature = get("x-teler-signature");
    if (!signature) {
      throw new WebhookSignatureError("Missing X-Teler-Signature header");
    }

    const expected = createHmac("sha256", this.config.webhook_secret).update(rawBody).digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookSignatureError("X-Teler-Signature mismatch");
    }
  }
}

registerAdapter("telephony.frejun_teler", (config) => new FreJunTelerTelephonyProvider(config));
