/**
 * The apps/web -> services/voice-gateway internal trigger client. This is
 * the "call answered" half of the telephony <-> voice-gateway audio bridge
 * (see docs/AUDIO_BRIDGE.md) — the OTHER half (a live provider's WebSocket
 * media stream itself) is entirely internal to the voice-gateway process
 * (`services/voice-gateway/voice_gateway/media_stream/server.py`) and never
 * touches apps/web.
 *
 * `notifyCallAnswered()` is called by the telephony webhook route
 * (`app/api/calls/webhook/[providerKey]/route.ts`) exactly once per call,
 * when a provider's webhook event reports the call is now `in_progress`
 * (i.e. answered) — this is the signal that a live media stream is about to
 * connect, so the voice-gateway needs a `ConversationOrchestrator` ready
 * for that `call_id` BEFORE the provider's WebSocket opens (see
 * `voice_gateway/media_stream/pipeline_manager.py`'s docstring for why the
 * ordering matters).
 *
 * Deliberately injectable `fetchImpl` (same DI pattern as every telephony
 * adapter in this codebase — see plivo.ts/frejun-teler.ts) so this is
 * testable with MockTelephony's webhook payload and no live voice-gateway
 * process running (see tests/voice-gateway/call-answered-wiring.test.ts).
 */

const DEFAULT_VOICE_GATEWAY_URL = "http://localhost:8100";

export type NotifyCallAnsweredParams = {
  callId: string;
  orgId: string;
  userId?: string | null;
  /** The TELEPHONY provider this call is using (plivo/frejun_teler/mock) —
   * passed through only for the voice-gateway's own logging; it does NOT
   * determine which STT/TTS/LLM providers the pipeline uses (that is
   * resolved independently via the Provider Registry, per
   * docs/PROVIDER_REGISTRY.md). */
  providerKey: string;
};

export class VoiceGatewayNotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceGatewayNotifyError";
  }
}

/**
 * POSTs to the voice-gateway's `/internal/pipelines/{callId}/start` route
 * (`voice_gateway/media_stream/internal_api.py`'s `handle_start_pipeline_request`).
 *
 * Failures here are logged, not thrown by default (a voice-gateway outage
 * must never fail the telephony webhook's 200 response back to the
 * provider — the provider would otherwise retry the whole webhook, which
 * `process_telephony_webhook_event`'s idempotency ledger already handles
 * safely, but there is no reason to couple the two). Pass
 * `{ throwOnError: true }` for a caller (e.g. a test, or a future
 * synchronous "start call" admin action) that wants to see the failure.
 */
export async function notifyCallAnswered(
  params: NotifyCallAnsweredParams,
  opts: { fetchImpl?: typeof fetch; throwOnError?: boolean } = {}
): Promise<{ ok: boolean; error?: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = process.env.VOICE_GATEWAY_URL ?? DEFAULT_VOICE_GATEWAY_URL;
  const url = `${baseUrl}/internal/pipelines/${encodeURIComponent(params.callId)}/start`;

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId: params.orgId,
        userId: params.userId ?? null,
        providerKey: params.providerKey,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const message = `voice-gateway notifyCallAnswered failed: ${res.status} ${text}`;
      if (opts.throwOnError) throw new VoiceGatewayNotifyError(message);
      console.error(message);
      return { ok: false, error: message };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof VoiceGatewayNotifyError && opts.throwOnError) throw err;
    const message = err instanceof Error ? err.message : "Unknown error calling voice-gateway";
    if (opts.throwOnError) throw new VoiceGatewayNotifyError(message);
    console.error(`voice-gateway notifyCallAnswered failed: ${message}`);
    return { ok: false, error: message };
  }
}
