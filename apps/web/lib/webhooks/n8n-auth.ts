import { NextRequest } from "next/server";

/**
 * Shared-secret auth for n8n -> apps/web control-plane webhooks (Phase 6).
 *
 * n8n is control-plane only and NEVER carries live call audio (an
 * established non-negotiable rule since Phase 0-4) — every workflow in
 * n8n/workflows/*.json only ever calls these lightweight JSON endpoints
 * (create a lead, trigger a call/WhatsApp send, read a small report), and
 * every actual telephony/WhatsApp action still goes through this app's own
 * Provider Registry + compliance gate, never through n8n directly.
 *
 * This is a Phase 6 MINIMUM: a single shared secret
 * (`N8N_WEBHOOK_SHARED_SECRET`) checked via the `x-n8n-webhook-token`
 * header, with the target org supplied in the request body/query as
 * `orgId`. A per-tenant token (so one tenant's n8n instance can't address
 * another tenant's endpoint even with a leaked shared secret) is a
 * documented follow-up — see the Phase 6 report's "deferred" list.
 */
export class N8nAuthError extends Error {
  constructor(message = "Invalid or missing n8n webhook token") {
    super(message);
    this.name = "N8nAuthError";
  }
}

export function assertValidN8nRequest(req: NextRequest): void {
  const expected = process.env.N8N_WEBHOOK_SHARED_SECRET;
  if (!expected) {
    // Fail closed: an unconfigured secret must never mean "any request is
    // accepted" — see docs/N8N_WORKFLOWS.md's setup checklist.
    throw new N8nAuthError("N8N_WEBHOOK_SHARED_SECRET is not configured on this deployment");
  }
  const provided = req.headers.get("x-n8n-webhook-token");
  if (provided !== expected) {
    throw new N8nAuthError();
  }
}
