import { createHmac, createHash } from "crypto";
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
 * PlivoTelephonyProvider — real REST API adapter.
 *
 * Verified against Plivo's current published docs (2026-09-21):
 *  - Create a call: POST https://api.plivo.com/v1/Account/{auth_id}/Call/
 *    JSON body: { from, to, answer_url, ... }, Basic Auth (auth_id:auth_token).
 *    https://www.plivo.com/docs/voice/api/call-new/
 *  - Hangup a call: DELETE https://api.plivo.com/v1/Account/{auth_id}/Call/{call_uuid}/
 *  - Transfer a live call: POST .../Call/{call_uuid}/ with a new answer_url
 *    (Plivo re-fetches XML/instructions from that URL to redirect the leg).
 *  - Get call status: GET https://api.plivo.com/v1/Account/{auth_id}/Call/{call_uuid}/
 *  - Recordings: GET .../Call/{call_uuid}/Record/ (list) — recording_url on
 *    the most recent completed recording.
 *  - Webhook signature: X-Plivo-Signature-V3 + X-Plivo-Signature-V3-Nonce
 *    headers. HMAC-SHA256(key = auth_token, message = url + sorted POST
 *    param values concatenated + nonce), base64-encoded, constant-time
 *    compared. Multiple comma-separated signatures may be present (one per
 *    active auth token on the account) — match against any.
 *    https://www.plivo.com/docs/voice/concepts/signature-validation
 *
 * NEEDS A REAL PLIVO ACCOUNT to smoke-test end-to-end (createCall against
 * the live API, and a real inbound webhook to check signature validation
 * against production headers). That is an infra/business step, not a code
 * gap — this adapter is unit-tested against a mocked HTTP client (see
 * apps/web/tests/providers/plivo-telephony.test.ts) covering request
 * shaping, response parsing, and signature verification logic.
 */

export type PlivoConfig = ProviderConfig & {
  auth_id: string;
  auth_token: string;
  /** Publicly reachable URL Plivo fetches call-flow XML from. */
  answer_url: string;
  /** Override for testing; defaults to Plivo's production API host. */
  base_url?: string;
};

const DEFAULT_BASE_URL = "https://api.plivo.com/v1";

function statusFromPlivo(plivoStatus: string): CallStatus {
  switch (plivoStatus) {
    case "queued":
      return "queued";
    case "ringing":
      return "ringing";
    case "in-progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "busy":
    case "failed":
      return "failed";
    case "no-answer":
      return "no_answer";
    default:
      return "failed";
  }
}

export class PlivoTelephonyProvider implements TelephonyProvider {
  readonly providerKey = "plivo";
  private readonly config: PlivoConfig;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ProviderConfig, fetchImpl: typeof fetch = fetch) {
    const cfg = config as PlivoConfig;
    if (!cfg.auth_id || !cfg.auth_token) {
      throw new Error("PlivoTelephonyProvider: config.auth_id and config.auth_token are required");
    }
    this.config = cfg;
    this.baseUrl = cfg.base_url ?? DEFAULT_BASE_URL;
    this.fetchImpl = fetchImpl;
  }

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.config.auth_id}:${this.config.auth_token}`).toString("base64");
  }

  private accountUrl(path: string): string {
    return `${this.baseUrl}/Account/${this.config.auth_id}${path}`;
  }

  async createCall(params: CreateCallParams): Promise<CreateCallResult> {
    const res = await this.fetchImpl(this.accountUrl("/Call/"), {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: params.fromNumber,
        to: params.toNumber,
        answer_url: this.config.answer_url,
        answer_method: "POST",
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Plivo createCall failed: ${res.status} ${text}`);
    }
    const body = (await res.json()) as { request_uuid?: string; message?: string };
    if (!body.request_uuid) {
      throw new Error(`Plivo createCall: unexpected response shape ${JSON.stringify(body)}`);
    }
    return { providerCallId: body.request_uuid, status: "queued" };
  }

  async endCall(providerCallId: string): Promise<void> {
    const res = await this.fetchImpl(this.accountUrl(`/Call/${providerCallId}/`), {
      method: "DELETE",
      headers: { Authorization: this.authHeader() },
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Plivo endCall failed: ${res.status}`);
    }
  }

  async transferCall(providerCallId: string, toNumber: string): Promise<void> {
    // Plivo transfers a live call by POSTing a new answer_url that returns
    // XML dialing the new number; we pass the destination via query string
    // on the configured answer_url so the app's XML endpoint knows who to
    // dial next.
    const res = await this.fetchImpl(this.accountUrl(`/Call/${providerCallId}/`), {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        legs: "aleg",
        aleg_url: `${this.config.answer_url}?transfer_to=${encodeURIComponent(toNumber)}`,
        aleg_method: "POST",
      }),
    });
    if (!res.ok) {
      throw new Error(`Plivo transferCall failed: ${res.status}`);
    }
  }

  async getCallStatus(providerCallId: string): Promise<CallStatusResult> {
    const res = await this.fetchImpl(this.accountUrl(`/Call/${providerCallId}/`), {
      method: "GET",
      headers: { Authorization: this.authHeader() },
    });
    if (!res.ok) {
      throw new Error(`Plivo getCallStatus failed: ${res.status}`);
    }
    const body = (await res.json()) as { call_status: string; call_duration?: string };
    return {
      providerCallId,
      status: statusFromPlivo(body.call_status),
      durationSeconds: body.call_duration ? Number(body.call_duration) : undefined,
    };
  }

  async streamAudio(params: StreamAudioParams): Promise<void> {
    // Plivo's live audio streaming is started by returning <Stream> XML from
    // answer_url (fetched when the call connects), not a separate REST call.
    // This method exists to satisfy the shared interface and to document
    // that intent for the future voice-gateway's answer_url handler, which
    // is expected to embed params.streamUrl into that XML.
    void params;
  }

  async receiveWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string
  ): Promise<NormalizedWebhookEvent> {
    this.verifySignature(headers, rawBody);

    const params = new URLSearchParams(rawBody);
    const providerCallId = params.get("CallUUID") ?? params.get("RequestUUID") ?? "";
    const eventType = params.get("Event") ?? "status_callback";
    const plivoStatus = params.get("CallStatus");
    const recordingUrl = params.get("RecordUrl") ?? undefined;

    if (!providerCallId) {
      throw new Error("Plivo webhook: missing CallUUID/RequestUUID");
    }

    // Plivo doesn't send a dedicated delivery/event id, so derive a stable
    // idempotency key from the full raw body — a retried delivery of the
    // exact same event has an identical body and therefore the same key.
    const idempotencyKey = createHash("sha256").update(rawBody).digest("hex");

    return {
      idempotencyKey,
      providerCallId,
      eventType,
      status: plivoStatus ? statusFromPlivo(plivoStatus) : undefined,
      recordingUrl,
      raw: Object.fromEntries(params.entries()),
    };
  }

  async recordCall(providerCallId: string): Promise<RecordCallResult> {
    const res = await this.fetchImpl(this.accountUrl(`/Call/${providerCallId}/Record/`), {
      method: "GET",
      headers: { Authorization: this.authHeader() },
    });
    if (!res.ok) {
      return { recordingUrl: null };
    }
    const body = (await res.json()) as { objects?: Array<{ record_url?: string }> };
    return { recordingUrl: body.objects?.[0]?.record_url ?? null };
  }

  /**
   * X-Plivo-Signature-V3 verification. See class docstring for the scheme.
   * `headers.url` is not itself a header; callers must include the exact
   * publicly-reachable request URL Plivo signed against as
   * `headers["x-forwarded-url"]` is NOT reliable in most setups — production
   * wiring should pass the adapter the configured answer_url/webhook URL
   * instead of trusting a client-controlled header. For simplicity here we
   * require the caller to have already put that URL in `x-plivo-request-url`.
   */
  private verifySignature(headers: Record<string, string | string[] | undefined>, rawBody: string): void {
    const get = (name: string): string | undefined => {
      const v = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };

    const signatureHeader = get("x-plivo-signature-v3");
    const nonce = get("x-plivo-signature-v3-nonce");
    const requestUrl = get("x-plivo-request-url");

    if (!signatureHeader || !nonce || !requestUrl) {
      throw new WebhookSignatureError("Missing X-Plivo-Signature-V3/nonce/request-url");
    }

    const params = new URLSearchParams(rawBody);
    const sortedValues = Array.from(params.keys())
      .sort()
      .map((k) => params.get(k) ?? "")
      .join("");
    const message = `${requestUrl}${sortedValues}${nonce}`;
    const expected = createHmac("sha256", this.config.auth_token).update(message).digest("base64");

    const candidates = signatureHeader.split(",").map((s) => s.trim());
    const matches = candidates.some((candidate) => timingSafeEqualStr(candidate, expected));
    if (!matches) {
      throw new WebhookSignatureError("X-Plivo-Signature-V3 mismatch");
    }
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

registerAdapter("telephony.plivo", (config) => new PlivoTelephonyProvider(config));
