/**
 * TelephonyProvider — the adapter contract every telephony provider
 * implements. This is the TypeScript realization, for apps/web, of the
 * conceptual `TelephonyAdapter` Protocol documented in
 * services/voice-gateway/PROVIDERS.md (that file's Python shape is for the
 * future voice-gateway service; this interface is the one apps/web's
 * calling code — e.g. app/api/calls/route.ts — actually imports and calls).
 *
 * Business logic (API routes, server actions) must depend ONLY on this
 * interface, obtained via `getTelephonyProvider()` in
 * apps/web/lib/providers/registry.ts. It must never import a concrete
 * adapter class directly or switch on `providerKey` — see
 * docs/PROVIDER_REGISTRY.md.
 */

export type CallStatus =
  | "queued"
  | "ringing"
  | "in_progress"
  | "completed"
  | "failed"
  | "no_answer";

export type CreateCallParams = {
  toNumber: string;
  fromNumber: string;
  /** Tenant/org this call belongs to — adapters must include this in any
   * webhook callback URL they register, so receiveWebhook can attribute
   * inbound events to the right tenant without trusting caller-supplied org
   * fields. */
  orgId: string;
  /** Opaque app-side call id (this platform's calls.id), passed through so
   * webhooks can be matched back to our own row without a provider_call_id
   * lookup racing the initial createCall() response. */
  appCallId: string;
};

export type CreateCallResult = {
  /** The provider's own identifier for this call (calls.provider_call_id). */
  providerCallId: string;
  status: CallStatus;
};

export type CallStatusResult = {
  providerCallId: string;
  status: CallStatus;
  durationSeconds?: number;
};

export type StreamAudioParams = {
  providerCallId: string;
  /** Where the provider should open its bidirectional media WebSocket
   * (the future voice-gateway service). Mock/adapters that don't yet wire
   * real streaming can no-op. */
  streamUrl: string;
};

export type RecordCallResult = {
  recordingUrl: string | null;
};

/**
 * A webhook event, already verified and normalized by the adapter's
 * receiveWebhook(), for the caller (the API route) to persist. `idempotencyKey`
 * MUST be stable across retried deliveries of the same provider event, so the
 * caller can enforce idempotency against telephony_webhook_events
 * (UNIQUE (provider_key, idempotency_key) — see
 * db/migrations/007_provider_registry.sql).
 */
export type NormalizedWebhookEvent = {
  idempotencyKey: string;
  providerCallId: string;
  eventType: string;
  status?: CallStatus;
  recordingUrl?: string;
  raw: unknown;
};

export class WebhookSignatureError extends Error {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export interface TelephonyProvider {
  /** Stable key matching `providers.provider_key` / `tenant_provider_config.provider_key`. */
  readonly providerKey: string;

  createCall(params: CreateCallParams): Promise<CreateCallResult>;

  endCall(providerCallId: string): Promise<void>;

  transferCall(providerCallId: string, toNumber: string): Promise<void>;

  getCallStatus(providerCallId: string): Promise<CallStatusResult>;

  streamAudio(params: StreamAudioParams): Promise<void>;

  /**
   * Verifies the inbound webhook's signature against this provider's
   * scheme, then normalizes the payload. Throws WebhookSignatureError if
   * verification fails — callers must reject the request (401/403) rather
   * than process an unverified event.
   */
  receiveWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<NormalizedWebhookEvent>;

  recordCall(providerCallId: string): Promise<RecordCallResult>;
}

/** Per-tenant, per-adapter config, decrypted and validated by the registry
 * before being handed to an adapter's constructor. Each adapter narrows this
 * to the fields it actually needs. */
export type ProviderConfig = Record<string, unknown>;
