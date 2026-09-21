import { NextRequest, NextResponse } from "next/server";
import { withoutTenant } from "@/lib/db/tenant";
import { resolveAdapterFactory } from "@/lib/providers/adapter-map";
import { WebhookSignatureError } from "@/lib/providers/telephony/types";
import { decryptProviderConfig, isEncryptedConfig } from "@/lib/providers/crypto";
import { notifyCallAnswered } from "@/lib/voice-gateway/client";
import "@/lib/providers/telephony/adapters/mock";
import "@/lib/providers/telephony/adapters/plivo";
import "@/lib/providers/telephony/adapters/frejun-teler";

/**
 * POST /api/calls/webhook/[providerKey] — inbound telephony webhook
 * endpoint. Idempotent by construction: every event is recorded through
 * `process_telephony_webhook_event` (db/migrations/007_provider_registry.sql),
 * a SECURITY DEFINER function with a UNIQUE (provider_key, idempotency_key)
 * constraint — a retried delivery of the same event is a no-op the second
 * time, never a duplicate call-state transition.
 *
 * We can't know which tenant a webhook belongs to before parsing/verifying
 * it (there is no session), so signature verification must happen with
 * *some* provider config. Since telephony credentials are per-tenant, this
 * route first looks up the call's owning org by provider_call_id (done
 * inside the SECURITY DEFINER function, which is allowed to cross the
 * tenant boundary for exactly this narrow purpose — see
 * 006_auth_functions.sql for the established pattern), then re-verifies the
 * signature against that tenant's configured secret before trusting the
 * payload.
 *
 * To keep this endpoint provider-agnostic (no if/else on providerKey), the
 * route param only selects which adapter class validates/normalizes the
 * payload — via the same self-registering adapter map the registry uses,
 * looked up by "telephony.<providerKey>" — never business logic branching
 * on the provider name itself.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ providerKey: string }> }
): Promise<NextResponse> {
  const { providerKey } = await params;
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());

  const factory = resolveAdapterFactory(`telephony.${providerKey}`);
  if (!factory) {
    return NextResponse.json({ error: `Unknown telephony provider "${providerKey}"` }, { status: 404 });
  }

  // First pass: parse (without trusting) enough to find provider_call_id,
  // so we can look up which tenant's config to verify against. Adapters'
  // receiveWebhook() both verifies AND parses in one step, so we construct
  // it twice: once with that tenant's real config (found via a
  // config-free/first pass for providers, like mock, needing none), and — for
  // providers requiring per-tenant secrets — the config is loaded from
  // tenant_provider_config after an initial unverified peek at the body to
  // extract the provider's call id field. To avoid trusting an unverified
  // peek for anything security-sensitive, the peek is used ONLY to select
  // which tenant's config to verify with; the adapter itself still performs
  // real signature verification below before any event is accepted.
  const genericProviderCallId = extractProviderCallIdUnverified(rawBody);

  const tenantConfig = await withoutTenant(async (client) => {
    if (!genericProviderCallId) return null;
    const { rows } = await client.query(
      `SELECT tpc.config
         FROM calls c
         JOIN tenant_provider_config tpc
           ON tpc.org_id = c.org_id AND tpc.layer = 'telephony' AND tpc.provider_key = $2
        WHERE c.provider_call_id = $1
        LIMIT 1`,
      [genericProviderCallId, providerKey]
    );
    return rows[0]?.config ?? null;
  });

  const config = tenantConfig
    ? isEncryptedConfig(tenantConfig)
      ? decryptProviderConfig(tenantConfig)
      : (tenantConfig as Record<string, unknown>)
    : {};

  const adapter = factory(config);

  let event;
  try {
    event = await adapter.receiveWebhook(headers, rawBody);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid webhook" }, { status: 400 });
  }

  const result = await withoutTenant(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM process_telephony_webhook_event($1, $2, $3, $4, $5, $6, $7)`,
      [
        providerKey,
        event.idempotencyKey,
        event.providerCallId,
        event.eventType,
        event.status ?? null,
        event.recordingUrl ?? null,
        JSON.stringify(event.raw),
      ]
    );
    return rows[0];
  });

  // "Call answered" trigger for the telephony <-> voice-gateway audio
  // bridge (docs/AUDIO_BRIDGE.md): the FIRST time (was_new guards against a
  // retried webhook delivery re-triggering this) a call's status becomes
  // in_progress, tell the voice-gateway to build a ConversationOrchestrator
  // for it — the provider's own media-stream WebSocket is expected to
  // connect to services/voice-gateway shortly after, per that call's
  // provider config (see streamAudio()'s docstring on each adapter). A
  // voice-gateway outage here must never fail this webhook's response to
  // the telephony provider (see notifyCallAnswered()'s docstring) — it does
  // not throw by default.
  if (result.was_new && result.call_id && result.org_id && event.status === "in_progress") {
    await notifyCallAnswered({
      callId: result.call_id,
      orgId: result.org_id,
      providerKey,
    });
  }

  return NextResponse.json({ processed: result.was_new, callId: result.call_id }, { status: 200 });
}

function extractProviderCallIdUnverified(rawBody: string): string | null {
  try {
    const params = new URLSearchParams(rawBody);
    const fromForm = params.get("CallUUID") ?? params.get("RequestUUID");
    if (fromForm) return fromForm;
  } catch {
    // not form-encoded, fall through to JSON
  }
  try {
    const json = JSON.parse(rawBody) as { call_id?: string; provider_call_id?: string };
    return json.call_id ?? json.provider_call_id ?? null;
  } catch {
    return null;
  }
}
