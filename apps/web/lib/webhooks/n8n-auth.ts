import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { checkRateLimit, RateLimitExceededError } from "@/lib/security/rateLimit";
import { withoutTenant } from "@/lib/db/tenant";

/**
 * Per-tenant token auth for n8n -> apps/web control-plane webhooks.
 *
 * n8n is control-plane only and NEVER carries live call audio (an
 * established non-negotiable rule since Phase 0-4) — every workflow in
 * n8n/workflows/*.json only ever calls these lightweight JSON endpoints
 * (create a lead, trigger a call/WhatsApp send, read a small report), and
 * every actual telephony/WhatsApp action still goes through this app's own
 * Provider Registry + compliance gate, never through n8n directly.
 *
 * Gap-closing pass (was Phase 6's documented "Deferred" item, re-flagged
 * by Phase 10's audit but not fixed then): Phase 6 shipped ONE shared
 * secret (`N8N_WEBHOOK_SHARED_SECRET`) plus an explicit `orgId` supplied
 * by the caller in the request body/query — a leaked shared secret let a
 * caller address ANY org's endpoints if they also knew/guessed that org's
 * id. This resolves the trusted org id FROM the token itself
 * (`n8n_webhook_tokens` — db/migrations/016_gap_closing_pass.sql, looked
 * up via the SECURITY DEFINER `resolve_org_by_n8n_token()`, same pre-auth
 * pattern as `resolve_session()`), so a caller-supplied `orgId` in the
 * body/query is no longer trusted for tenant selection AT ALL — every
 * route now uses the `orgId` this function returns, never
 * `parsed.data.orgId`. A tenant's per-tenant token is generated/rotated
 * from the dashboard (`/dashboard/settings/n8n`,
 * `lib/webhooks/n8nToken.ts`) and configured as that tenant's OWN n8n
 * instance's `N8N_WEBHOOK_SHARED_SECRET`/`x-n8n-webhook-token` value —
 * same env var name and header as before, now tenant-specific rather than
 * platform-shared.
 *
 * Only the SHA-256 hash of the raw token is ever stored (never the raw
 * value) — same discipline as `sessions`/`users.password_hash` — and the
 * lookup is inherently timing-safe-equivalent (an index lookup on the
 * hash, not a string comparison against a single expected value), so
 * Phase 10's `timingSafeEqual` fix is superseded by this design rather
 * than needed here.
 *
 * Rate limiting (Phase 10): kept, now keyed by the RESOLVED org id rather
 * than source IP — this is per-tenant infrastructure now, so a burst from
 * one tenant's n8n instance should never throttle a different tenant's.
 */
export class N8nAuthError extends Error {
  constructor(message = "Invalid or missing n8n webhook token") {
    super(message);
    this.name = "N8nAuthError";
  }
}

export function hashN8nToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Resolves and returns the trusted org id for an incoming n8n webhook
 * request, from its `x-n8n-webhook-token` header ALONE. Every route calls
 * this and uses ITS return value as `orgId` for every DB operation that
 * follows — never a caller-supplied `orgId` from the body/query, which
 * (if a route's schema still accepts one for backward-compatible request
 * shapes) must be treated as informational only, never authorization.
 */
export async function assertValidN8nRequest(req: NextRequest): Promise<string> {
  const provided = req.headers.get("x-n8n-webhook-token");
  if (!provided) {
    throw new N8nAuthError();
  }

  const orgId = await withoutTenant(async (client) => {
    const { rows } = await client.query<{ org_id: string | null }>("SELECT resolve_org_by_n8n_token($1) AS org_id", [
      hashN8nToken(provided),
    ]);
    return rows[0]?.org_id ?? null;
  });
  if (!orgId) {
    throw new N8nAuthError();
  }

  try {
    await checkRateLimit(`n8n-webhook:${orgId}`, 120, 60);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      throw new N8nAuthError("Rate limit exceeded — too many requests from this source.");
    }
    throw err;
  }

  return orgId;
}
